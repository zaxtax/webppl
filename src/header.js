"use strict";

var assert = require('assert');
var _ = require('underscore');
var PriorityQueue = require('priorityqueuejs');
var util = require('./util.js');
var erp = require('./erp.js');

// Top address for naming
var address = "";

// Top global store for mutation (eg conjugate models)
var globalStore = {};


// function gaussianFactor(store, k, addr, mu, std, val){
//   top.coroutine.factor(store, k, addr, gaussianScore([mu, std], val));
// }

// function erpFactor(store, k, addr, erp, params, val){
//   top.coroutine.factor(store, k, addr, erp.score(params, val));
// }


////////////////////////////////////////////////////////////////////
// Inference interface
//
// An inference function takes the current continuation and a WebPPL
// thunk (which itself has been transformed to take a
// continuation). It does some kind of inference and returns an ERP
// representing the nromalized marginal distribution on return values.
//
// The inference function should install a coroutine object that
// provides sample, factor, and exit.
//
// sample and factor are the co-routine handlers: they get call/cc'ed
// from the wppl code to handle random stuff.
//
// The inference function passes exit to the wppl fn, so that it gets
// called when the fn is exited, it can call the inference cc when
// inference is done to contintue the program.

// This global variable tracks the current coroutine, sample and
// factor use it to interface with the inference algorithm. Default
// setting throws an error on factor calls.
var coroutine = {
  sample: function(s, cc, a, erp, params) {
    // Sample and keep going
    cc(s, erp.sample(params));
  },
  factor: function() {
    throw "factor allowed only inside inference.";
  },
  exit: function(s,r) {
    return r;
  }
};

// Functions that call methods of whatever the coroutine is set to
// when called, we do it like this so that 'this' will be set
// correctly to the coroutine object.
function sample(s, k, a, dist, params) {
  coroutine.sample(s, k, a, dist, params);
}

function factor(s, k, a, score) {
  coroutine.factor(s, k, a, score);
}

function sampleWithFactor(s, k, a, dist, params, scoreFn) {
  if (typeof coroutine.sampleWithFactor === "function"){
    coroutine.sampleWithFactor(s, k, a, dist, params, scoreFn);
  } else {
    var sampleK = function(s, v){
      var scoreK = function(s, sc){
        var factorK = function(s){
          k(s, v); };
        factor(s, factorK, a+"swf2", sc);};
      scoreFn(s, scoreK, a+"swf1", v);};
    sample(s, sampleK, a, dist, params);
  }
}

function exit(s,retval) {
  coroutine.exit(s,retval);
}



////////////////////////////////////////////////////////////////////
// Enumeration
//
// Depth-first enumeration of all the paths through the computation.
// Q is the queue object to use. It should have enq, deq, and size methods.

function Enumerate(s, k, a, wpplFn, maxExecutions, Q) {

  this.score = 0; // Used to track the score of the path currently being explored
  this.queue = Q; // Queue of states that we have yet to explore
  this.marginal = {}; // We will accumulate the marginal distribution here
  this.numCompletedExecutions = 0;
  this.maxExecutions = maxExecutions || Infinity;

  this.oldStore = s; // will be reinstated at the end

  // Move old coroutine out of the way and install this as the current handler
  this.k = k;
  this.oldCoroutine = coroutine;
  coroutine = this;

  // Run the wppl computation, when the computation returns we want it
  // to call the exit method of this coroutine so we pass that as the
  // continuation.
  wpplFn(s, exit, a);
}

// The queue is a bunch of computation states. each state is a
// continuation, a value to apply it to, and a score.
//
// This function runs the highest priority state in the
// queue. Currently priority is score, but could be adjusted to give
// depth-first or breadth-first or some other search strategy

var stackSize = 0;

Enumerate.prototype.nextInQueue = function() {
  var nextState = this.queue.deq();
  this.score = nextState.score;
  nextState.continuation(nextState.store, nextState.value);
};


Enumerate.prototype.sample = function(store, cc, a, dist, params, extraScoreFn) {

  //allows extra factors to be taken into account in making exploration decisions:
  extraScoreFn = extraScoreFn || function(x){return 0;};

  // Find support of this erp:
  if (!dist.support) {
    throw "Enumerate can only be used with ERPs that have support function.";
  }
  var supp = dist.support(params);

  // For each value in support, add the continuation paired with
  // support value and score to queue:
  for (var s in supp) {
    var state = {
      continuation: cc,
      value: supp[s],
      score: this.score + dist.score(params, supp[s]) + extraScoreFn(supp[s]),
      store: util.copyObj(store)
    };
    this.queue.enq(state);
  }
  // Call the next state on the queue
  this.nextInQueue();
};

Enumerate.prototype.factor = function(s,cc,a, score) {
  // Update score and continue
  this.score += score;
  cc(s);
};

// FIXME: can only call scoreFn in tail position!
// Enumerate.prototype.sampleWithFactor = function(s,cc,a,dist,params,scoreFn) {
//   coroutine.sample(s,cc,a,dist,params,
//                    function(v){
//                      var ret;
//                      scoreFn(s, function(s, x){ret = x;}, a+"swf", v);
//                      return ret;});
// };


Enumerate.prototype.exit = function(s,retval) {

  // We have reached an exit of the computation. Accumulate probability into retval bin.
  var r = JSON.stringify(retval);
  if (this.marginal[r] === undefined) {
    this.marginal[r] = {prob: 0, val: retval};
  }
  this.marginal[r].prob += Math.exp(this.score);

  // Increment the completed execution counter
  this.numCompletedExecutions++;

  // If anything is left in queue do it:
  if (this.queue.size() > 0 && (this.numCompletedExecutions < this.maxExecutions)) {
    this.nextInQueue();
  } else {
    var marginal = this.marginal;
    var dist = erp.makeMarginalERP(marginal);
    // Reinstate previous coroutine:
    coroutine = this.oldCoroutine;
    // Return from enumeration by calling original continuation with original store:
    this.k(this.oldStore, dist);
  }
};

//helper wraps with 'new' to make a new copy of Enumerate and set 'this' correctly..
function enuPriority(s,cc, a, wpplFn, maxExecutions) {
  var q = new PriorityQueue(function(a, b){return a.score-b.score;});
  return new Enumerate(s,cc,a, wpplFn, maxExecutions, q);
}

function enuFilo(s,cc,a, wpplFn, maxExecutions) {
  var q = [];
  q.size = function(){return q.length;};
  q.enq = q.push;
  q.deq = q.pop;
  return new Enumerate(s,cc,a, wpplFn, maxExecutions, q);
}

function enuFifo(s,cc,a, wpplFn, maxExecutions) {
  var q = [];
  q.size = function(){return q.length;};
  q.enq = q.push;
  q.deq = q.shift;
  return new Enumerate(s,cc,a, wpplFn, maxExecutions, q);
}


////////////////////////////////////////////////////////////////////
// Particle filtering
//
// Sequential importance re-sampling, which treats 'factor' calls as
// the synchronization / intermediate distribution points.

function copyParticle(particle){
  return {
    continuation: particle.continuation,
    weight: particle.weight,
    value: particle.value,
    store: util.copyObj(particle.store)
  };
}

function ParticleFilter(s, k, a, wpplFn, numParticles) {

  this.particles = [];
  this.particleIndex = 0;  // marks the active particle

  // Create initial particles
  for (var i=0; i<numParticles; i++) {
    var particle = {
      continuation: function(s){wpplFn(s,exit,a);},
      weight: 0,
      value: undefined,
      store: util.copyObj(s)
    };
    this.particles.push(particle);
  }

  // Move old coroutine out of the way and install this as the current
  // handler.
  this.k = k;
  this.oldCoroutine = coroutine;
  coroutine = this;

  this.oldStore = util.copyObj(s); // will be reinstated at the end

  // Run first particle
  this.activeParticle().continuation(this.activeParticle().store);
}

ParticleFilter.prototype.sample = function(s,cc, a, erp, params) {
  cc(s,erp.sample(params));
};

ParticleFilter.prototype.factor = function(s,cc, a, score) {
  // Update particle weight
  this.activeParticle().weight += score;
  this.activeParticle().continuation = cc;
  this.activeParticle().store = s;

  if (this.allParticlesAdvanced()){
    // Resample in proportion to weights
    this.resampleParticles();
    this.particleIndex = 0;
  } else {
    // Advance to the next particle
    this.particleIndex += 1;
  }

  coroutine.activeParticle().continuation(coroutine.activeParticle().store);
};

ParticleFilter.prototype.activeParticle = function() {
  return this.particles[this.particleIndex];
};

ParticleFilter.prototype.allParticlesAdvanced = function() {
  return ((this.particleIndex + 1) === this.particles.length);
};

ParticleFilter.prototype.resampleParticles = function() {
  // Residual resampling following Liu 2008; p. 72, section 3.4.4
  var m = this.particles.length;
  var W = util.logsumexp(_.map(this.particles, function(p){return p.weight;}));
  var resetW = W - Math.log(m);

  // Compute list of retained particles
  var retainedParticles = [];
  var newExpWeights = [];
  _.each(
    this.particles,
    function(particle){
      var w = Math.exp(particle.weight - resetW);
      var nRetained = Math.floor(w);
      newExpWeights.push(w - nRetained);
      for (var i=0; i<nRetained; i++) {
        retainedParticles.push(copyParticle(particle));
      }});

  // Compute new particles
  var numNewParticles = m - retainedParticles.length;
  var newParticles = [];
  var j;
  for (var i=0; i<numNewParticles; i++){
    j = multinomialSample(newExpWeights);
    newParticles.push(copyParticle(this.particles[j]));
  }

  // Particles after update: Retained + new particles
  this.particles = newParticles.concat(retainedParticles);

  // Reset all weights
  _.each(this.particles, function(particle){particle.weight = resetW;});
};

ParticleFilter.prototype.exit = function(s, retval) {

  this.activeParticle().value = retval;

  // Wait for all particles to reach exit before computing
  // marginal distribution from particles
  if (!this.allParticlesAdvanced()){
    this.particleIndex += 1;
    return this.activeParticle().continuation(this.activeParticle().store);
  }

  // Compute marginal distribution from (unweighted) particles
  var hist = {};
  _.each(
    this.particles,
    function(particle){
      var k = JSON.stringify(particle.value);
      if (hist[k] === undefined){
        hist[k] = { prob:0, val:particle.value };
      }
      hist[k].prob += 1;
    });
  var dist = erp.makeMarginalERP(hist);

  // Reinstate previous coroutine:
  coroutine = this.oldCoroutine;

  // Return from particle filter by calling original continuation:
  this.k(this.oldStore, dist);
};

function pf(s, cc, a, wpplFn, numParticles) {
  return new ParticleFilter(s, cc, a, wpplFn, numParticles);
}

////////////////////////////////////////////////////////////////////
// Lightweight MH

function MH(s, k, a, wpplFn, numIterations) {

  this.trace = [];
  this.oldTrace = undefined;
  this.currScore = 0;
  this.oldScore = -Infinity;
  this.oldVal = undefined;
  this.regenFrom = 0;
  this.returnHist = {};
  this.k = k;
  this.oldStore = util.copyObj(s);
  this.iterations = numIterations;

  // Move old coroutine out of the way and install this as the current
  // handler.
  this.oldCoroutine = coroutine;
  coroutine = this;

  wpplFn(s, exit, a);
}

MH.prototype.factor = function(s, k, a, score) {
  coroutine.currScore += score;
  k(s);
};

MH.prototype.sample = function(s, cont, name, erp, params, forceSample) {
  var prev = findChoice(coroutine.oldTrace, name);
  var reuse = ! (prev===undefined || forceSample);
  var val = reuse ? prev.val : erp.sample(params);
  var choiceScore = erp.score(params,val);
  coroutine.trace.push({k: cont, name: name, erp: erp, params: params,
                       score: coroutine.currScore, choiceScore: choiceScore,
                       val: val, reused: reuse, store: util.copyObj(s)});
  coroutine.currScore += choiceScore;
  cont(s, val);
};

function findChoice(trace, name) {
  if (trace === undefined){
    return undefined;
  }
  for (var i = 0; i < trace.length; i++){
    if (trace[i].name === name){
      return trace[i];
    }
  }
  return undefined;
}

function mhAcceptProb(trace, oldTrace, regenFrom, currScore, oldScore){
  if (oldTrace === undefined){return 1;} //just for init
  var fw = -Math.log(oldTrace.length);
  trace.slice(regenFrom).map(function(s){fw += s.reused?0:s.choiceScore;});
  var bw = -Math.log(trace.length);
  oldTrace.slice(regenFrom).map(function(s){
    var nc = findChoice(trace, s.name);
    bw += (!nc || !nc.reused) ? s.choiceScore : 0;  });
  var acceptance = Math.min(1, Math.exp(currScore - oldScore + bw - fw));
  return acceptance;
}

MH.prototype.exit = function(s, val) {
  if (coroutine.iterations > 0) {
    coroutine.iterations -= 1;

    //did we like this proposal?
    var acceptance = mhAcceptProb(coroutine.trace, coroutine.oldTrace,
                                  coroutine.regenFrom, coroutine.currScore, coroutine.oldScore);
    if (Math.random() >= acceptance){
      // if rejected, roll back trace, etc:
      coroutine.trace = coroutine.oldTrace;
      coroutine.currScore = coroutine.oldScore;
      val = coroutine.oldVal;
    }

    // now add val to hist:
    var stringifiedVal = JSON.stringify(val);
    if (coroutine.returnHist[stringifiedVal] === undefined){
      coroutine.returnHist[stringifiedVal] = { prob:0, val:val };
    }
    coroutine.returnHist[stringifiedVal].prob += 1;

    // make a new proposal:
    coroutine.regenFrom = Math.floor(Math.random() * coroutine.trace.length);
    var regen = coroutine.trace[coroutine.regenFrom];
    coroutine.oldTrace = coroutine.trace;
    coroutine.trace = coroutine.trace.slice(0, coroutine.regenFrom);
    coroutine.oldScore = coroutine.currScore;
    coroutine.currScore = regen.score;
    coroutine.oldVal = val;

    coroutine.sample(regen.store, regen.k, regen.name, regen.erp, regen.params, true);
  } else {
    var dist = erp.makeMarginalERP(coroutine.returnHist);

    // Reinstate previous coroutine:
    var k = coroutine.k;
    coroutine = this.oldCoroutine;

    // Return by calling original continuation:
    k(this.oldStore, dist);
  }
};

function mh(s, cc, a, wpplFn, numParticles) {
  return new MH(s, cc, a, wpplFn, numParticles);
}


////////////////////////////////////////////////////////////////////
// PMCMC

function last(xs){
  return xs[xs.length - 1];
}

function PMCMC(s, cc, a, wpplFn, numParticles, numSweeps){

  // Move old coroutine out of the way and install this as the
  // current handler.
  this.oldCoroutine = coroutine;
  coroutine = this;

  // Store continuation (will be passed dist at the end)
  this.k = cc;

  this.oldStore = util.copyObj(s);

  // Setup inference variables
  this.particleIndex = 0;  // marks the active particle
  this.retainedParticle = undefined;
  this.numSweeps = numSweeps;
  this.sweep = 0;
  this.wpplFn = wpplFn;
  this.address = a;
  this.numParticles = numParticles;
  this.resetParticles();
  this.returnHist = {};

  // Run first particle
  this.activeContinuationWithStore()();
}

PMCMC.prototype.resetParticles = function(){
  var that = this;
  this.particles = [];
  // Create initial particles
  for (var i=0; i<this.numParticles; i++) {
    var particle = {
      continuations: [function(s){that.wpplFn(s, exit, that.address);}],
      stores: [that.oldStore],
      weights: [0],
      value: undefined
    };
    this.particles.push(util.copyObj(particle));
  }
};

PMCMC.prototype.activeParticle = function() {
  return this.particles[this.particleIndex];
};

PMCMC.prototype.activeContinuation = function(){
  return last(this.activeParticle().continuations);
};

PMCMC.prototype.activeContinuationWithStore = function(){
  var k = last(this.activeParticle().continuations);
  var s = last(this.activeParticle().stores);
  return function(){k(s);};
};

PMCMC.prototype.allParticlesAdvanced = function() {
  return ((this.particleIndex + 1) === this.particles.length);
};

PMCMC.prototype.sample = function(s, cc, a, erp, params) {
  cc(s, erp.sample(params));
};

PMCMC.prototype.particleAtStep = function(particle, step){
  // Returns particle s.t. particle.continuations[step] is the last entry
  return {
    continuations: particle.continuations.slice(0, step + 1),
    stores: particle.stores.slice(0, step + 1),
    weights: particle.weights.slice(0, step + 1),
    value: particle.value
  };
};

PMCMC.prototype.updateActiveParticle = function(weight, continuation, store){
  var particle = this.activeParticle();
  particle.continuations = particle.continuations.concat([continuation]);
  particle.stores = particle.stores.concat([util.copyObj(store)]);
  particle.weights = particle.weights.concat([weight]);
};

PMCMC.prototype.copyParticle = function(particle){
  return {
    continuations: particle.continuations.slice(0),
    weights: particle.weights.slice(0),
    value: particle.value,
    stores: particle.stores.map(util.copyObj)
  };
};

PMCMC.prototype.resampleParticles = function(particles){
  var weights = particles.map(
    function(particle){return Math.exp(last(particle.weights));});

  var j;
  var newParticles = [];
  for (var i=0; i<particles.length; i++){
    j = multinomialSample(weights);
    newParticles.push(this.copyParticle(particles[j]));
  }

  return newParticles;
};

PMCMC.prototype.factor = function(s, cc, a, score) {

  this.updateActiveParticle(score, cc, s);

  if (this.allParticlesAdvanced()){
    if (this.sweep > 0){
      // This is not the first sweep, so we have a retained particle;
      // take that into account when resampling
      var particles = this.particles;
      var step = this.particles[0].continuations.length - 1;
      particles = particles.concat(this.particleAtStep(this.retainedParticle, step));
      this.particles = this.resampleParticles(particles).slice(1);
    } else {
      // No retained particle - standard particle filtering
      this.particles = this.resampleParticles(this.particles);
    }
    this.particleIndex = 0;
  } else {
    // Move next particle along
    this.particleIndex += 1;
  }

  this.activeContinuationWithStore()();
};

PMCMC.prototype.exit = function(s, retval) {

  this.activeParticle().value = retval;

  if (!this.allParticlesAdvanced()){

    // Wait for all particles to reach exit
    this.particleIndex += 1;
    return this.activeContinuationWithStore()();

  } else {

    // Use all (unweighted) particles from the conditional SMC
    // iteration to estimate marginal distribution.
    if (this.sweep > 0) {
      this.particles.concat(this.retainedParticle).forEach(
        function(particle){
          var k = JSON.stringify(particle.value);
          if (coroutine.returnHist[k] === undefined){
            coroutine.returnHist[k] = { prob:0, val:particle.value };
          }
          coroutine.returnHist[k].prob += 1;
        });
    }

    // Retain the first particle sampled after the final factor statement.
    this.retainedParticle = this.particles[0];

    if (this.sweep < this.numSweeps) {

      // Reset non-retained particles, restart
      this.sweep += 1;
      this.particleIndex = 0;
      this.resetParticles();
      this.activeContinuationWithStore()();

    } else {
      var dist = erp.makeMarginalERP(this.returnHist);

      // Reinstate previous coroutine:
      coroutine = this.oldCoroutine;

      // Return from particle filter by calling original continuation:
      this.k(this.oldStore, dist);

    }
  }
};

function pmc(s, cc, a, wpplFn, numParticles, numSweeps) {
  return new PMCMC(s, cc, a, wpplFn, numParticles, numSweeps);
}


////////////////////////////////////////////////////////////////////
// Particle filter with lightweight MH rejuvenation.
//
// Sequential importance re-sampling, which treats 'factor' calls as
// the synchronization / intermediate distribution points.
// After each factor particles are rejuvenated via lightweight MH.
//
// If numParticles==1 this amounts to MH with an (expensive) annealed init (but only returning one sample),
// if rejuvSteps==0 this is a plain PF without any MH.

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
  this.oldCoroutine = coroutine;
  coroutine = this;

  this.oldStore = s; // will be reinstated at the end

  // Create initial particles
  for (var i=0; i<numParticles; i++) {
    var particle = {
    continuation: function(s){wpplFn(s,exit,a);},
    weight: 0,
    score: 0,
    value: undefined,
    trace: [],
    store: s
    };
    coroutine.particles.push(particle);
  }

  // Run first particle
  coroutine.activeParticle().continuation(coroutine.activeParticle().store);
}

ParticleFilterRejuv.prototype.sample = function(s,cc,a, erp, params) {
  var val = erp.sample(params);
  var choiceScore = erp.score(params,val);
  coroutine.activeParticle().trace.push(
                                   {k: cc, name: a, erp: erp, params: params,
                                   score: undefined, //FIXME: need to track particle total score?
                                   choiceScore: choiceScore,
                                   val: val, reused: false,
                                   store: s});
  coroutine.activeParticle().score += choiceScore;
  cc(s,val);
};

ParticleFilterRejuv.prototype.factor = function(s,cc,a, score) {
  // Update particle weight and score
  coroutine.activeParticle().weight += score;
  coroutine.activeParticle().score += score;
  coroutine.activeParticle().continuation = cc;
  coroutine.activeParticle().store = s;

  if (coroutine.allParticlesAdvanced()){
    // Resample in proportion to weights
    coroutine.resampleParticles();
    //rejuvenate each particle via MH
    util.cpsForEach(
      function(particle, i, particles, nextK){
        // make sure mhp coroutine doesn't escape:
        assert(coroutine.isParticleFilterRejuvCoroutine);
        new MHP(
          function(p){
            particles[i]=p;
            nextK();
          },
          particle, coroutine.baseAddress,
          a, coroutine.wpplFn, coroutine.rejuvSteps);
      },
      function(){
        coroutine.particleIndex = 0;
        coroutine.activeParticle().continuation(coroutine.activeParticle().store);
      },
      coroutine.particles
    );
  } else {
    // Advance to the next particle
    coroutine.particleIndex += 1;
    coroutine.activeParticle().continuation(coroutine.activeParticle().store);
  }
};

ParticleFilterRejuv.prototype.activeParticle = function() {
  return coroutine.particles[coroutine.particleIndex];
};

ParticleFilterRejuv.prototype.allParticlesAdvanced = function() {
  return ((coroutine.particleIndex + 1) == coroutine.particles.length);
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
  var m = coroutine.particles.length;
  var W = util.logsumexp(_.map(coroutine.particles, function(p){return p.weight;}));
  var resetW = W - Math.log(m);

  // Compute list of retained particles
  var retainedParticles = [];
  var newExpWeights = [];
  _.each(
    coroutine.particles,
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
    j = multinomialSample(newExpWeights);
    newParticles.push(copyPFRParticle(this.particles[j]));
  }

  // Particles after update: Retained + new particles
  coroutine.particles = newParticles.concat(retainedParticles);

  // Reset all weights
  _.each(coroutine.particles, function(particle){particle.weight = resetW;});
};

ParticleFilterRejuv.prototype.exit = function(s,retval) {

  coroutine.activeParticle().value = retval;

  // Wait for all particles to reach exit before computing
  // marginal distribution from particles
  if (!coroutine.allParticlesAdvanced()){
    coroutine.particleIndex += 1;
    return coroutine.activeParticle().continuation(coroutine.activeParticle().store);
  }

  //Final rejuvenation:
  var oldStore = this.oldStore;
  util.cpsForEach(
    function(particle, i, particles, nextK){
      // make sure mhp coroutine doesn't escape:
      assert(coroutine.isParticleFilterRejuvCoroutine);
      new MHP(
        function(p){
          particles[i]=p;
          nextK();
        },
        particle, coroutine.baseAddress,
        undefined, coroutine.wpplFn, coroutine.rejuvSteps);
    },
    function(){
      // Compute marginal distribution from (unweighted) particles
      var hist = {};
      _.each(
        coroutine.particles,
        function(particle){
          var k = JSON.stringify(particle.value);
          if (hist[k] === undefined){
            hist[k] = { prob:0, val:particle.value };
          }
          hist[k].prob += 1;
        });
      var dist = erp.makeMarginalERP(hist);

      // Reinstate previous coroutine:
      var k = coroutine.k;
      coroutine = coroutine.oldCoroutine;

      // Return from particle filter by calling original continuation:
      k(oldStore, dist);
    },
    coroutine.particles
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
    this.oldCoroutine = coroutine;
    coroutine = this;
    coroutine.propose(); //FIXME: on final exit, will this end up calling the MH exit correctly?
  }
}

MHP.prototype.factor = function(s,k,a,sc) {
  coroutine.currScore += sc;
  if (a == coroutine.limitAddress) { //we need to exit if we've reached the fathest point of this particle...
    exit(s);
  } else {
    k(s);
  }
};

MHP.prototype.sample = function(s,k, name, erp, params, forceSample) {
  var prev = findChoice(coroutine.oldTrace, name);
  var reuse = !(prev===undefined || forceSample);
  var val = reuse ? prev.val : erp.sample(params);
  var choiceScore = erp.score(params,val);
  coroutine.trace.push({k: k, name: name, erp: erp, params: params,
                       score: coroutine.currScore, choiceScore: choiceScore,
                       val: val, reused: reuse, store:s});
  coroutine.currScore += choiceScore;
  k(s, val);
};


MHP.prototype.propose = function() {
  //make a new proposal:
  coroutine.regenFrom = Math.floor(Math.random() * coroutine.trace.length);
  var regen = coroutine.trace[coroutine.regenFrom];
  coroutine.oldTrace = coroutine.trace;
  coroutine.trace = coroutine.trace.slice(0,coroutine.regenFrom);
  coroutine.oldScore = coroutine.currScore;
  coroutine.currScore = regen.score;
  coroutine.oldVal = coroutine.val;

  coroutine.sample(regen.store, regen.k, regen.name, regen.erp, regen.params, true);
};

MHP.prototype.exit = function(s,val) {

  coroutine.val = val;

  //did we like this proposal?
  var acceptance = mhAcceptProb(coroutine.trace, coroutine.oldTrace,
                                coroutine.regenFrom, coroutine.currScore, coroutine.oldScore);
  if (Math.random() >= acceptance){
    //if rejected, roll back trace, etc:
    coroutine.trace = coroutine.oldTrace;
    coroutine.currScore = coroutine.oldScore;
    coroutine.val = coroutine.oldVal;
  }

  coroutine.iterations -= 1;

  if( coroutine.iterations > 0 ) {
    coroutine.propose();
  } else {
    var newParticle = {continuation: coroutine.originalParticle.continuation,
                        weight: coroutine.originalParticle.weight,
                        value: coroutine.val,
                        trace: coroutine.trace,
                        store: s
                      };

    // Reinstate previous coroutine and return by calling original continuation:
    var backToPF = coroutine.backToPF;
    coroutine = coroutine.oldCoroutine;
    backToPF(newParticle);
  }
}


function pfr(s,cc, a, wpplFn, numParticles, rejuvSteps) {
  return new ParticleFilterRejuv(s,cc, a, wpplFn, numParticles, rejuvSteps);
}


////////////////////////////////////////////////////////////////////
// Simple Variational inference wrt the (pseudo)mean-field program.
// We do stochastic gradient descent on the ERP params.
// On sample statements: sample and accumulate grad-log-score, orig-score, and variational-score
// On factor statements accumulate into orig-score.

function Variational(s,k,a, wpplFn, estS) {

  this.wpplFn = wpplFn;
  this.estimateSamples = estS;
  this.numS = 0;
  this.t = 1;
  this.variationalParams = {};
  //historic gradient squared for each variational param, used for adagrad update:
  this.runningG2 = {};
  //gradient estimate per iteration:
  this.grad = {};
  //gradient of each sample used to estimate gradient:
  this.samplegrad = {};
  //running score accumulation per sample:
  this.jointScore = 0;
  this.variScore = 0;

  // Move old coroutine out of the way and install this as the current
  // handler.
  this.k = k;
  this.oldCoroutine = coroutine;
  coroutine = this;

  this.initialStore = s; // will be reinstated at the end
  this.initialAddress = a;

  //kick off the estimation:
  this.takeGradSample();
}

Variational.prototype.takeGradSample = function() {
  //reset sample info
  coroutine.samplegrad = {};
  coroutine.jointScore = 0;
  coroutine.variScore = 0;
  //get another sample
  coroutine.numS++;
  coroutine.wpplFn(coroutine.initialStore, exit, coroutine.initialAddress);
}

Variational.prototype.sample = function(s,k,a, erp, params) {
  //sample from variational dist
  if(!coroutine.variationalParams.hasOwnProperty(a)){
    //initialize at prior (for this sample)...
    coroutine.variationalParams[a] = params;
    coroutine.runningG2[a]=[0];//fixme: vec size
  }
  var vParams = coroutine.variationalParams[a];
  var val = erp.sample(vParams);

  //compute variational dist grad
  coroutine.samplegrad[a] = erp.grad(vParams, val);

  //compute target score + variational score
  coroutine.jointScore += erp.score(params, val);
  coroutine.variScore += erp.score(vParams, val);

  k(s,val); //TODO: need a?
};

Variational.prototype.factor = function(s,k,a, score) {

  //update joint score and keep going
  coroutine.jointScore += score;

  k(s); //TODO: need a?
};

Variational.prototype.exit = function(s,retval) {
  //FIXME: params are arrays, so need vector arithmetic or something..

  //update gradient estimate
  for (var a in coroutine.samplegrad) {
    if (!coroutine.grad.hasOwnProperty(a)){
      //FIXME: size param vec:
      coroutine.grad[a]=[0];
    }
    coroutine.grad[a] = vecPlus(
      coroutine.grad[a],
      vecScalarMult(coroutine.samplegrad[a],
                    (coroutine.jointScore - coroutine.variScore)));
  }

  //do we have as many samples as we need for this gradient estimate?
  if (coroutine.numS < coroutine.estimateSamples) {
    return coroutine.takeGradSample();
  }

  //we have all our samples to do a gradient step.
  //use AdaGrad update rule.
  //update variational parameters:
  for (a in coroutine.variationalParams){
    for (var i in coroutine.variationalParams[a]) {
      var grad = coroutine.grad[a][i] / coroutine.numS;
      coroutine.runningG2[a][i] += Math.pow(grad, 2);
      var weight = 1.0/Math.sqrt(coroutine.runningG2[a][i]);
//        console.log(a+" "+i+": weight "+ weight +" grad "+ grad +" vparam "+coroutine.variationalParams[a][i])
      coroutine.variationalParams[a][i] += weight*grad;
    }
  }
  coroutine.t++;
  console.log(coroutine.variationalParams);

  //if we haven't converged then do another gradient estimate and step:
  //FIXME: converence test instead of fixed number of grad steps?
  if (coroutine.t<500) {
    coroutine.grad = {};
    coroutine.numS = 0;
    return coroutine.takeGradSample();
  }

  //return variational dist as ERP:
  //FIXME
  console.log(coroutine.variationalParams);
  var dist = null;

  // Reinstate previous coroutine:
  var k = coroutine.k;
  var s = coroutine.initialStore;
  coroutine = coroutine.oldCoroutine;

  // Return from particle filter by calling original continuation:
  k(s,dist);
};

function vecPlus(a,b) {
  var c = [];
  for(var i=0;i<a.length;i++) {
    c[i] = a[i] + b[i];
  }
  return c;
}

function vecScalarMult(a,s) {
  var c = [];
  for(var i=0;i<a.length;i++) {
    c[i] = a[i]*s;
  }
  return c;
}

function vari(s,cc, a, wpplFn, estS) {
  return new Variational(s,cc, a, wpplFn, estS);
}


////////////////////////////////////////////////////////////////////
// Some primitive functions to make things simpler

function display(s,k, a, x) {
  k(s, console.log(x));
}

// Caching for a wppl function f. caution: if f isn't deterministic
// weird stuff can happen, since caching is across all uses of f, even
// in different execuation paths.
//FIXME: use global store for caching?
function cache(s, k, a, f) {
  var c = {};
  var cf = function(s, k, a) {
    var args = Array.prototype.slice.call(arguments, 3);
    var stringedArgs = JSON.stringify(args);
    if (stringedArgs in c) {
      k(s, c[stringedArgs]);
    } else {
      var newk = function(s, r) {
        c[stringedArgs] = r;
        k(s, r);
      };
      f.apply(this, [s, newk, a].concat(args));
    }
  };
  k(s, cf);
}

// FIXME: handle fn.apply in cps transform?
function apply(s, k, a, wpplFn, args){
  return wpplFn.apply(global, [s, k, a].concat(args));
}


////////////////////////////////////////////////////////////////////

module.exports = {
  _: _,
  ERP: erp.ERP,
  Enumerate: enuPriority,
  EnumerateBreadthFirst: enuFifo,
  EnumerateDepthFirst: enuFilo,
  EnumerateLikelyFirst: enuPriority,
  MH: mh,
  PMCMC: pmc,
  ParticleFilter: pf,
  ParticleFilterRejuv: pfr,
  Variational: vari,
  address: address,
  bernoulliERP: erp.bernoulliERP,
  betaERP: erp.betaERP,
  binomialERP: erp.binomialERP,
  cache: cache,
  coroutine: coroutine,
  dirichletERP: erp.dirichletERP,
  discreteERP: erp.discreteERP,
  display: display,
  exponentialERP: erp.exponentialERP,
  factor: factor,
  gammaERP: erp.gammaERP,
  gaussianERP: erp.gaussianERP,
  globalStore: globalStore,
  multinomialSample: erp.multinomialSample,
  poissonERP: erp.poissonERP,
  randomIntegerERP: erp.randomIntegerERP,
  sample: sample,
  sampleWithFactor: sampleWithFactor,
  uniformERP: erp.uniformERP,
  util: util,
  apply: apply
};
