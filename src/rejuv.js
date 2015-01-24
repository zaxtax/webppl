////////////////////////////////////////////////////////////////////
// Particle filter with lightweight MH rejuvenation.
//
// Sequential importance re-sampling, which treats 'factor' calls as
// the synchronization / intermediate distribution points.
// After each factor particles are rejuvenated via lightweight MH.
//
// If numParticles==1 this amounts to MH with an (expensive) annealed
// init (but only returning one sample),
// if rejuvSteps==0 this is a plain PF without any MH.

"use strict";

var _ = require('underscore');
var mh = require('./mh.js');
var util = require('./util.js');
var erp = require('./erp.js');
var assert = require('assert');


module.exports = function(top){

  function ParticleFilterRejuv(s,k,a, wpplFn, numParticles, rejuvSteps) {

    this.particles = [];
    this.particleIndex = 0;  // marks the active particle
    this.rejuvSteps = rejuvSteps;
    this.baseAddress = a;
    this.wpplFn = wpplFn;
    this.isParticleFilterRejuvCoroutine = true;

    // Move old coroutine out of the way and install this as the current
    // handler.
    this.k = k;
    this.oldCoroutine = top.coroutine;
    top.coroutine = this;

    this.oldStore = s; // will be reinstated at the end

    // Create initial particles
    for (var i=0; i<numParticles; i++) {
      var particle = {
        continuation: function(s){wpplFn(s,top.exit,a);},
        weight: 0,
        score: 0,
        value: undefined,
        trace: [],
        store: s
      };
      top.coroutine.particles.push(particle);
    }

    // Run first particle
    top.coroutine.activeParticle().continuation(top.coroutine.activeParticle().store);
  }

  ParticleFilterRejuv.prototype.sample = function(s,cc,a, erp, params) {
    var val = erp.sample(params);
    var choiceScore = erp.score(params,val);
    top.coroutine.activeParticle().trace.push(
      {k: cc, name: a, erp: erp, params: params,
       score: undefined, //FIXME: need to track particle total score?
       choiceScore: choiceScore,
       val: val, reused: false,
       store: s});
    top.coroutine.activeParticle().score += choiceScore;
    cc(s,val);
  };

  ParticleFilterRejuv.prototype.factor = function(s,cc,a, score) {
    // Update particle weight and score
    top.coroutine.activeParticle().weight += score;
    top.coroutine.activeParticle().score += score;
    top.coroutine.activeParticle().continuation = cc;
    top.coroutine.activeParticle().store = s;

    if (top.coroutine.allParticlesAdvanced()){
      // Resample in proportion to weights
      top.coroutine.resampleParticles();
      //rejuvenate each particle via MH
      util.cpsForEach(
        function(particle, i, particles, nextK){
          // make sure mhp coroutine doesn't escape:
          assert(top.coroutine.isParticleFilterRejuvCoroutine);
          new MHP(
            function(p){
              particles[i]=p;
              nextK();
            },
            particle, top.coroutine.baseAddress,
            a, top.coroutine.wpplFn, top.coroutine.rejuvSteps);
        },
        function(){
          top.coroutine.particleIndex = 0;
          top.coroutine.activeParticle().continuation(top.coroutine.activeParticle().store);
        },
        top.coroutine.particles
      );
    } else {
      // Advance to the next particle
      top.coroutine.particleIndex += 1;
      top.coroutine.activeParticle().continuation(top.coroutine.activeParticle().store);
    }
  };

  ParticleFilterRejuv.prototype.activeParticle = function() {
    return top.coroutine.particles[top.coroutine.particleIndex];
  };

  ParticleFilterRejuv.prototype.allParticlesAdvanced = function() {
    return ((top.coroutine.particleIndex + 1) == top.coroutine.particles.length);
  };

  function copyPFRParticle(particle){
    return {
      continuation: particle.continuation,
      weight: particle.weight,
      value: particle.value,
      score: particle.score,
      store: particle.store,
      trace: particle.trace //FIXME: need to deep copy trace??
    };
  }

  ParticleFilterRejuv.prototype.resampleParticles = function() {
    // Residual resampling following Liu 2008; p. 72, section 3.4.4
    var m = top.coroutine.particles.length;
    var W = util.logsumexp(_.map(top.coroutine.particles, function(p){return p.weight;}));
    var resetW = W - Math.log(m);

    // Compute list of retained particles
    var retainedParticles = [];
    var newExpWeights = [];
    _.each(
      top.coroutine.particles,
      function(particle){
        var w = Math.exp(particle.weight - resetW);
        var nRetained = Math.floor(w);
        newExpWeights.push(w - nRetained);
        for (var i=0; i<nRetained; i++) {
          retainedParticles.push(copyPFRParticle(particle));
        }});

    // Compute new particles
    var numNewParticles = m - retainedParticles.length;
    var newParticles = [];
    var j;
    for (var i=0; i<numNewParticles; i++){
      j = erp.multinomialSample(newExpWeights);
      newParticles.push(copyPFRParticle(this.particles[j]));
    }

    // Particles after update: Retained + new particles
    top.coroutine.particles = newParticles.concat(retainedParticles);

    // Reset all weights
    _.each(top.coroutine.particles, function(particle){particle.weight = resetW;});
  };

  ParticleFilterRejuv.prototype.exit = function(s,retval) {

    top.coroutine.activeParticle().value = retval;

    // Wait for all particles to reach exit before computing
    // marginal distribution from particles
    if (!top.coroutine.allParticlesAdvanced()){
      top.coroutine.particleIndex += 1;
      return top.coroutine.activeParticle().continuation(top.coroutine.activeParticle().store);
    }

    //Final rejuvenation:
    var oldStore = this.oldStore;
    util.cpsForEach(
      function(particle, i, particles, nextK){
        // make sure mhp coroutine doesn't escape:
        assert(top.coroutine.isParticleFilterRejuvCoroutine);
        new MHP(
          function(p){
            particles[i]=p;
            nextK();
          },
          particle, top.coroutine.baseAddress,
          undefined, top.coroutine.wpplFn, top.coroutine.rejuvSteps);
      },
      function(){
        // Compute marginal distribution from (unweighted) particles
        var hist = {};
        _.each(
          top.coroutine.particles,
          function(particle){
            var k = JSON.stringify(particle.value);
            if (hist[k] === undefined){
              hist[k] = { prob:0, val:particle.value };
            }
            hist[k].prob += 1;
          });
        var dist = erp.makeMarginalERP(hist);

        // Reinstate previous coroutine:
        var k = top.coroutine.k;
        top.coroutine = top.coroutine.oldCoroutine;

        // Return from particle filter by calling original continuation:
        k(oldStore, dist);
      },
      top.coroutine.particles
    );

  };


  ////// Lightweight MH on a particle

  function MHP(backToPF, particle, baseAddress, limitAddress , wpplFn, numIterations) {

    this.trace = particle.trace;
    this.oldTrace = undefined;
    this.currScore = particle.score;
    this.oldScore = undefined;
    this.val = particle.value;
    this.regenFrom = undefined;
    this.backToPF = backToPF;
    this.iterations = numIterations;
    this.limitAddress = limitAddress;
    this.originalParticle = particle;

    // FIXME: do we need to save the store here?

    if (numIterations===0) {
      backToPF(particle);
    } else {
      // Move PF coroutine out of the way and install this as the current
      // handler.
      this.oldCoroutine = top.coroutine;
      top.coroutine = this;
      top.coroutine.propose(); //FIXME: on final exit, will this end up calling the MH exit correctly?
    }
  }

  MHP.prototype.factor = function(s,k,a,sc) {
    top.coroutine.currScore += sc;
    if (a == top.coroutine.limitAddress) { //we need to exit if we've reached the fathest point of this particle...
      top.exit(s);
    } else {
      k(s);
    }
  };

  MHP.prototype.sample = function(s,k, name, erp, params, forceSample) {
    var prev = mh.findChoice(top.coroutine.oldTrace, name);
    var reuse = !(prev===undefined || forceSample);
    var val = reuse ? prev.val : erp.sample(params);
    var choiceScore = erp.score(params,val);
    top.coroutine.trace.push({k: k, name: name, erp: erp, params: params,
                              score: top.coroutine.currScore, choiceScore: choiceScore,
                              val: val, reused: reuse, store:s});
    top.coroutine.currScore += choiceScore;
    k(s, val);
  };


  MHP.prototype.propose = function() {
    //make a new proposal:
    top.coroutine.regenFrom = Math.floor(Math.random() * top.coroutine.trace.length);
    var regen = top.coroutine.trace[top.coroutine.regenFrom];
    top.coroutine.oldTrace = top.coroutine.trace;
    top.coroutine.trace = top.coroutine.trace.slice(0,top.coroutine.regenFrom);
    top.coroutine.oldScore = top.coroutine.currScore;
    top.coroutine.currScore = regen.score;
    top.coroutine.oldVal = top.coroutine.val;

    top.sample(regen.store, regen.k, regen.name, regen.erp, regen.params, true);
  };

  MHP.prototype.exit = function(s,val) {

    top.coroutine.val = val;

    //did we like this proposal?
    var acceptance = mh.mhAcceptProb(top.coroutine.trace, top.coroutine.oldTrace,
                                     top.coroutine.regenFrom, top.coroutine.currScore, top.coroutine.oldScore);
    if (Math.random() >= acceptance){
      //if rejected, roll back trace, etc:
      top.coroutine.trace = top.coroutine.oldTrace;
      top.coroutine.currScore = top.coroutine.oldScore;
      top.coroutine.val = top.coroutine.oldVal;
    }

    top.coroutine.iterations -= 1;

    if( top.coroutine.iterations > 0 ) {
      top.coroutine.propose();
    } else {
      var newParticle = {continuation: top.coroutine.originalParticle.continuation,
                         weight: top.coroutine.originalParticle.weight,
                         value: top.coroutine.val,
                         trace: top.coroutine.trace,
                         store: s
                        };

      // Reinstate previous coroutine and return by calling original continuation:
      var backToPF = top.coroutine.backToPF;
      top.coroutine = top.coroutine.oldCoroutine;
      backToPF(newParticle);
    }
  }


  function pfr(s,cc, a, wpplFn, numParticles, rejuvSteps) {
    return new ParticleFilterRejuv(s,cc, a, wpplFn, numParticles, rejuvSteps);
  }

  return {
    pfr: pfr
  }
}
