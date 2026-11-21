// Resolve frontend test dependencies in both the workspace and GitHub layouts.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const root=path.resolve(__dirname,'..');
const frontend=fs.existsSync(path.join(root,'src'))?root:path.join(root,'web-app');
const frontendRequire=Module.createRequire(path.join(frontend,'package.json'));
const candidate=path.join(root,'django-server','myenv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
process.chdir(root);
fs.mkdirSync(path.join(root,'output'),{recursive:true});
module.exports={root,frontend,require:frontendRequire,esbuild:frontendRequire('esbuild'),
  paths:Module._nodeModulePaths(frontend),
  python:process.env.SFERA_TEST_PYTHON||(fs.existsSync(candidate)?candidate:(process.platform==='win32'?'python.exe':'python'))};
