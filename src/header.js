"use strict";

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

// The top.coroutine global variable tracks the current coroutine,
// sample and factor use it to interface with the inference
// algorithm. Default setting throws an error on factor calls.

// Sample, factor, etc are functions that call methods of whatever the
// coroutine is set to when called, we do it like this so that 'this'
// will be set correctly to the coroutine object.

module.exports = function(top){

  var assert = require('assert');
  var _ = require('underscore');
  var util = require('./util.js');
  var erp = require('./erp.js');
  
  var enumerate = require('./enumerate.js')(top);
  var mh = require('./mh.js')(top);
  var particlefilter = require('./particlefilter.js')(top);
  var pmcmc = require('./pmcmc.js')(top);
  var rejuv = require('./rejuv.js')(top);
  var variational = require('./variational.js')(top);

  top.coroutine = {
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

  top.sample = function(s, k, a, dist, params) {
    top.coroutine.sample(s, k, a, dist, params);
  }

  top.factor = function(s, k, a, score) {
    top.coroutine.factor(s, k, a, score);
  }

  top.sampleWithFactor = function(s, k, a, dist, params, scoreFn) {
    if (typeof top.coroutine.sampleWithFactor === "function"){
      top.coroutine.sampleWithFactor(s, k, a, dist, params, scoreFn);
    } else {
      var sampleK = function(s, v){
        var scoreK = function(s, sc){
          var factorK = function(s){
            k(s, v); };
          top.factor(s, factorK, a+"swf2", sc);};
        scoreFn(s, scoreK, a+"swf1", v);};
      top.sample(s, sampleK, a, dist, params);
    }
  }

  top.exit = function(s,retval) {
    top.coroutine.exit(s,retval);
  }

  top.address = "";

  top.globalStore = {};


  ////////////////////////////////////////////////////////////////////
  // Some primitive functions to make things simpler

  function display(s, k, a, x) {
    k(s, console.log(x));
  }

  // Caching for a wppl function f. caution: if f isn't deterministic
  // weird stuff can happen, since caching is across all uses of f, even
  // in different execuation paths.
  // FIXME: use global store for caching?
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

  return {
    _: _,
    ERP: erp.ERP,
    Enumerate: enumerate.enuPriority,
    EnumerateBreadthFirst: enumerate.enuFifo,
    EnumerateDepthFirst: enumerate.enuFilo,
    EnumerateLikelyFirst: enumerate.enuPriority,
    MH: mh.mh,
    PMCMC: pmcmc.pmcmc,
    ParticleFilter: particlefilter.pf,
    ParticleFilterRejuv: rejuv.pfr,
    Variational: variational.vari,
    // address: address,
    bernoulliERP: erp.bernoulliERP,
    betaERP: erp.betaERP,
    binomialERP: erp.binomialERP,
    cache: cache,
    // coroutine: coroutine,
    dirichletERP: erp.dirichletERP,
    discreteERP: erp.discreteERP,
    display: display,
    exponentialERP: erp.exponentialERP,
    // factor: factor,
    gammaERP: erp.gammaERP,
    gaussianERP: erp.gaussianERP,
    // globalStore: globalStore,
    multinomialSample: erp.multinomialSample,
    poissonERP: erp.poissonERP,
    randomIntegerERP: erp.randomIntegerERP,
    // sample: sample,
    // sampleWithFactor: sampleWithFactor,
    uniformERP: erp.uniformERP,
    util: util,
    apply: apply
  };
  
};
