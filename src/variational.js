////////////////////////////////////////////////////////////////////
// Simple Variational inference wrt the (pseudo)mean-field program.
// We do stochastic gradient descent on the ERP params.
// On sample statements: sample and accumulate grad-log-score, orig-score, and variational-score
// On factor statements accumulate into orig-score.

"use strict";

var util = require('./util.js');
var erp = require('./erp.js');


module.exports = function(top){

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
    this.oldCoroutine = top.coroutine;
    top.coroutine = this;

    this.initialStore = s; // will be reinstated at the end
    this.initialAddress = a;

    //kick off the estimation:
    this.takeGradSample();
  }

  Variational.prototype.takeGradSample = function() {
    //reset sample info
    top.coroutine.samplegrad = {};
    top.coroutine.jointScore = 0;
    top.coroutine.variScore = 0;
    //get another sample
    top.coroutine.numS++;
    top.coroutine.wpplFn(top.coroutine.initialStore, top.exit, top.coroutine.initialAddress);
  }

  Variational.prototype.sample = function(s,k,a, erp, params) {
    //sample from variational dist
    if(!top.coroutine.variationalParams.hasOwnProperty(a)){
      //initialize at prior (for this sample)...
      top.coroutine.variationalParams[a] = params;
      top.coroutine.runningG2[a]=[0];//fixme: vec size
    }
    var vParams = top.coroutine.variationalParams[a];
    var val = erp.sample(vParams);

    //compute variational dist grad
    top.coroutine.samplegrad[a] = erp.grad(vParams, val);

    //compute target score + variational score
    top.coroutine.jointScore += erp.score(params, val);
    top.coroutine.variScore += erp.score(vParams, val);

    k(s,val); //TODO: need a?
  };

  Variational.prototype.factor = function(s,k,a, score) {

    //update joint score and keep going
    top.coroutine.jointScore += score;

    k(s); //TODO: need a?
  };

  Variational.prototype.exit = function(s,retval) {
    //FIXME: params are arrays, so need vector arithmetic or something..

    //update gradient estimate
    for (var a in top.coroutine.samplegrad) {
      if (!top.coroutine.grad.hasOwnProperty(a)){
        //FIXME: size param vec:
        top.coroutine.grad[a]=[0];
      }
      top.coroutine.grad[a] = vecPlus(
        top.coroutine.grad[a],
        vecScalarMult(top.coroutine.samplegrad[a],
                      (top.coroutine.jointScore - top.coroutine.variScore)));
    }

    //do we have as many samples as we need for this gradient estimate?
    if (top.coroutine.numS < top.coroutine.estimateSamples) {
      return top.coroutine.takeGradSample();
    }

    //we have all our samples to do a gradient step.
    //use AdaGrad update rule.
    //update variational parameters:
    for (a in top.coroutine.variationalParams){
      for (var i in top.coroutine.variationalParams[a]) {
        var grad = top.coroutine.grad[a][i] / top.coroutine.numS;
        top.coroutine.runningG2[a][i] += Math.pow(grad, 2);
        var weight = 1.0/Math.sqrt(top.coroutine.runningG2[a][i]);
        //        console.log(a+" "+i+": weight "+ weight +" grad "+ grad +" vparam "+top.coroutine.variationalParams[a][i])
        top.coroutine.variationalParams[a][i] += weight*grad;
      }
    }
    top.coroutine.t++;
    console.log(top.coroutine.variationalParams);

    //if we haven't converged then do another gradient estimate and step:
    //FIXME: converence test instead of fixed number of grad steps?
    if (top.coroutine.t<500) {
      top.coroutine.grad = {};
      top.coroutine.numS = 0;
      return top.coroutine.takeGradSample();
    }

    //return variational dist as ERP:
    //FIXME
    console.log(top.coroutine.variationalParams);
    var dist = null;

    // Reinstate previous coroutine:
    var k = top.coroutine.k;
    var s = top.coroutine.initialStore;
    top.coroutine = top.coroutine.oldCoroutine;

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

  return {
    vari: vari
  }
};
