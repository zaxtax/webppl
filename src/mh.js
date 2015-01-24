"use strict";

var util = require('./util.js');
var erp = require('./erp.js');


module.exports = function(top){

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
    this.oldCoroutine = top.coroutine;
    top.coroutine = this;

    wpplFn(s, top.exit, a);
  }

  MH.prototype.factor = function(s, k, a, score) {
    top.coroutine.currScore += score;
    k(s);
  };

  MH.prototype.sample = function(s, cont, name, erp, params, forceSample) {
    var prev = findChoice(top.coroutine.oldTrace, name);
    var reuse = ! (prev===undefined || forceSample);
    var val = reuse ? prev.val : erp.sample(params);
    var choiceScore = erp.score(params,val);
    top.coroutine.trace.push({k: cont, name: name, erp: erp, params: params,
                              score: top.coroutine.currScore, choiceScore: choiceScore,
                              val: val, reused: reuse, store: util.copyObj(s)});
    top.coroutine.currScore += choiceScore;
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
    if (top.coroutine.iterations > 0) {
      top.coroutine.iterations -= 1;

      //did we like this proposal?
      var acceptance = mhAcceptProb(top.coroutine.trace, top.coroutine.oldTrace,
                                    top.coroutine.regenFrom, top.coroutine.currScore, top.coroutine.oldScore);
      if (Math.random() >= acceptance){
        // if rejected, roll back trace, etc:
        top.coroutine.trace = top.coroutine.oldTrace;
        top.coroutine.currScore = top.coroutine.oldScore;
        val = top.coroutine.oldVal;
      }

      // now add val to hist:
      var stringifiedVal = JSON.stringify(val);
      if (top.coroutine.returnHist[stringifiedVal] === undefined){
        top.coroutine.returnHist[stringifiedVal] = { prob:0, val:val };
      }
      top.coroutine.returnHist[stringifiedVal].prob += 1;

      // make a new proposal:
      top.coroutine.regenFrom = Math.floor(Math.random() * top.coroutine.trace.length);
      var regen = top.coroutine.trace[top.coroutine.regenFrom];
      top.coroutine.oldTrace = top.coroutine.trace;
      top.coroutine.trace = top.coroutine.trace.slice(0, top.coroutine.regenFrom);
      top.coroutine.oldScore = top.coroutine.currScore;
      top.coroutine.currScore = regen.score;
      top.coroutine.oldVal = val;

      top.coroutine.sample(regen.store, regen.k, regen.name, regen.erp, regen.params, true);
    } else {
      var dist = erp.makeMarginalERP(top.coroutine.returnHist);

      // Reinstate previous coroutine:
      var k = top.coroutine.k;
      top.coroutine = this.oldCoroutine;

      // Return by calling original continuation:
      k(this.oldStore, dist);
    }
  };

  function mh(s, cc, a, wpplFn, numParticles) {
    return new MH(s, cc, a, wpplFn, numParticles);
  }

  return {
    mh: mh,
    findChoice: findChoice,
    mhAcceptProb: mhAcceptProb
  };
};
