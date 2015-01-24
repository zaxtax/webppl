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


var top = {
  continuation: null,
  trampoline: null,
  compiledHeader: null
};

var header = require("./header")(top);


// --------------------------------------------------------------------
// Compile

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
  if (verbose && console.time){
    console.time('compile');
  }

  var programAst, headerAst;

  // Compile & cache WPPL header
  if (top.compiledHeader){
    headerAst = top.compiledHeader;
  } else {
    var headerCode = fs.readFileSync(__dirname + "/header.wppl");
    headerAst = compile(headerCode, 'dummyCont', true);
    top.compiledHeader = headerAst;
  }

  // Compile program code
  programAst = compile(programCode, 'continuation', false);
  if (verbose){
    console.log(escodegen.generate(programAst));
  }

  // Concatenate header and program
  var out = escodegen.generate(addHeaderAst(programAst, headerAst));

  if (verbose && console.timeEnd){
    console.timeEnd('compile');
  }
  return out;
}


// --------------------------------------------------------------------
// Run

function evalInContext(context, code){
  var result = function(c){
    return eval(c);
  }.call(context, code);
  return result;
}

function run(code, contFun, verbose){
  top.continuation = function(s, x){
    top.trampoline = null;
    contFun(s, x);
  };
  var compiledCode = compileProgram(code, verbose);
  return evalInContext(top, compiledCode); // ?? or access as top.continuation?
}


// --------------------------------------------------------------------
// Utilities for use in browser

if (util.runningInBrowser()){
  
  function webpplCPS(code){
    var programAst = esprima.parse(code);
    var newProgramAst = optimize(cps(programAst, build.identifier("continuation")));
    return escodegen.generate(newProgramAst);
  }

  function webpplNaming(code){
    var programAst = esprima.parse(code);
    var newProgramAst = naming(programAst);
    return escodegen.generate(newProgramAst);
  }

  window.webppl = {
    run: run,
    compile: compileProgram,
    cps: webpplCPS,
    naming: webpplNaming
  };
  
  console.log("webppl loaded.");
}


module.exports = {
  run: run,
  compile: compileProgram,
  compileRaw: compile
};
