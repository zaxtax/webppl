"use strict";

var assert = require('assert');
var fs = require('fs');
var types = require("ast-types");
var build = types.builders;
var esprima = require("esprima");
var escodegen = require("escodegen");
var cps = require("./cps").cps;
var optimize = require("./optimize").optimize;
var naming = require("./naming").naming;
var store = require("./store").store;
var varargs = require("./varargs").varargs;
var trampoline = require("./trampoline").trampoline;
var util = require("./util");

var topK;
var _trampoline;

// Make runtime stuff globally available:
var runtime = require("./header.js");
for (var prop in runtime){
  if (runtime.hasOwnProperty(prop)){
    global[prop] = runtime[prop];
  }
}

global.CACHED_WEBPPL_HEADER = undefined;

function addHeaderAst(targetAst, headerAst){
  targetAst.body = headerAst.body.concat(targetAst.body);
  return targetAst;
}

function removeFinalContinuationCall(ast, contName){
  var x = ast.body[0];
  var lastNode = x.body[x.body.length-1];
  assert(types.namedTypes.ExpressionStatement.check(lastNode));
  assert(types.namedTypes.CallExpression.check(lastNode.expression));
  assert(types.namedTypes.Identifier.check(lastNode.expression.callee));
  assert.equal(lastNode.expression.callee.name, contName);
  x.body = x.body.slice(0, x.body.length-1);
}

var compile = function(code, contName, isLibrary){
  var ast = esprima.parse(code);
  var cont = build.identifier(contName);
  ast = naming(ast);
  ast = cps(ast, cont);
  if (isLibrary){
    // library contains only function definitions, so remove
    // unnecessary final dummy continuation call
    removeFinalContinuationCall(ast, contName);
  }
  ast = store(ast);
  ast = optimize(ast);
  ast = varargs(ast);
  ast = trampoline(ast, isLibrary);
  return ast;
};

function compileProgram(programCode, verbose){
  if (verbose && console.time){console.time('compile');}

  var programAst, headerAst;

  // Compile & cache WPPL header
  if (global.CACHED_WEBPPL_HEADER){
    headerAst = global.CACHED_WEBPPL_HEADER;
  } else {
    var headerCode = fs.readFileSync(__dirname + "/header.wppl");
    headerAst = compile(headerCode, 'dummyCont', true);
    global.CACHED_WEBPPL_HEADER = headerAst;
  }

  // Compile program code
  programAst = compile(programCode, 'topK', false);
  if (verbose){
    console.log(escodegen.generate(programAst));
  }

  // Concatenate header and program
  var out = escodegen.generate(addHeaderAst(programAst, headerAst));

  if (verbose && console.timeEnd){console.timeEnd('compile');}
  return out;
}

function run(code, contFun, verbose){
  topK = function(s, x){
    _trampoline = null;
    contFun(s, x);
  };
  var compiledCode = compileProgram(code, verbose);
  return eval(compiledCode);
}

// Compile and run some webppl code in global scope:
function webppl_eval(k, code, verbose) {
  var oldk = global.topK;
  global._trampoline = undefined;
  global.topK = function(s, x){  // Install top-level continuation
    global._trampoline = null;
    k(s, x);
    global.topK = oldk;
  };
  var compiledCode = compileProgram(code, verbose);
  eval.call(global, compiledCode);
}

// For use in browser
function webpplCPS(code){
  var programAst = esprima.parse(code);
  var newProgramAst = optimize(cps(programAst, build.identifier("topK")));
  return escodegen.generate(newProgramAst);
}

function webpplNaming(code){
  var programAst = esprima.parse(code);
  var newProgramAst = naming(programAst);
  return escodegen.generate(newProgramAst);
}

// For use in browser using browserify
if (util.runningInBrowser()){
  window.webppl = {
    run: run,
    compile: compileProgram,
    cps: webpplCPS,
    naming: webpplNaming
  };
  console.log("webppl loaded.");
} else {
  // Put eval into global scope. browser version??
  global.webppl_eval = webppl_eval;
}

module.exports = {
  webppl_eval: webppl_eval,
  run: run,
  compile: compileProgram,
  compileRaw: compile
};
