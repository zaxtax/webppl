////////////////////////////////////////////////////////////////////
// Enumeration
//
// Enumeration of all the paths through the computation.
// Q is the queue object to use. It should have enq, deq, and size methods.

"use strict";

var util = require('./util.js');
var erp = require('./erp.js');
var PriorityQueue = require('priorityqueuejs');

module.exports = function(top){

  function Enumerate(s, k, a, wpplFn, maxExecutions, Q) {

    this.score = 0; // Used to track the score of the path currently being explored
    this.queue = Q; // Queue of states that we have yet to explore
    this.marginal = {}; // We will accumulate the marginal distribution here
    this.numCompletedExecutions = 0;
    this.maxExecutions = maxExecutions || Infinity;

    this.oldStore = s; // will be reinstated at the end

    // Move old coroutine out of the way and install this as the current handler
    this.k = k;
    this.oldCoroutine = top.coroutine;
    top.coroutine = this;

    // Run the wppl computation, when the computation returns we want it
    // to call the exit method of this coroutine so we pass that as the
    // continuation.
    wpplFn(s, top.exit, a);
  }

  // The queue is a bunch of computation states. each state is a
  // continuation, a value to apply it to, and a score.
  //
  // This function runs the highest priority state in the
  // queue. Currently priority is score, but could be adjusted to give
  // depth-first or breadth-first or some other search strategy

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
      top.coroutine = this.oldCoroutine;
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

  return {
    Enumerate: enuPriority,
    EnumerateBreadthFirst: enuFifo,
    EnumerateDepthFirst: enuFilo,
    EnumerateLikelyFirst: enuPriority,
  };

};
