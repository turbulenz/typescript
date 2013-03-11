//﻿
// Copyright (c) Microsoft Corporation.  All rights reserved.
// 
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//

///<reference path='typescript.ts'/>
///<reference path='io.ts'/>
///<reference path='optionsParser.ts'/>

class ErrorReporter implements ITextWriter {
    public hasErrors: bool;

    constructor(public ioHost: IIO) {
        this.hasErrors = false;
    }

    public Write(s: string) {
        this.hasErrors = true;
        this.ioHost.stderr.Write(s);
    }

    public WriteLine(s: string) {
        this.hasErrors = true;
        this.ioHost.stderr.WriteLine(s);
    }

    public Close() {
    }

    public reset() {
        this.hasErrors = false;
    }
}

class CommandLineHost implements TypeScript.IResolverHost {

    public pathMap: any = {};
    public resolvedPaths: any = {};

    constructor(public compilationSettings: TypeScript.CompilationSettings, public errorReporter: (err:string)=>void) { 
    }

    public getPathIdentifier(path: string) { 
        return this.compilationSettings.useCaseSensitiveFileResolution ? path : path.toLocaleUpperCase();
    }

    public isResolved(path: string) {
        return this.resolvedPaths[this.getPathIdentifier(this.pathMap[path])] != undefined;
    }

    public resolveCompilationEnvironment(preEnv: TypeScript.CompilationEnvironment,
        resolver: TypeScript.ICodeResolver,
        traceDependencies: bool): TypeScript.CompilationEnvironment {
        var resolvedEnv = new TypeScript.CompilationEnvironment(preEnv.compilationSettings, preEnv.ioHost);

        var nCode = preEnv.code.length;
        var path = "";

        var postResolutionError = 
            (errorFile: string, errorMessage: string) => {
                this.errorReporter(errorFile + (errorMessage == "" ? "" : ": " + errorMessage));
            }

        var resolutionDispatcher: TypeScript.IResolutionDispatcher = {
            postResolutionError: (errorFile, line, col, errorMessage) => {
                this.errorReporter(errorFile + "(" + line + "," + col + ") " + (errorMessage == "" ? "" : ": " + errorMessage));
            },
            postResolution: (path: string, code: TypeScript.ISourceText) => {
                var pathId = this.getPathIdentifier(path);
                if (!this.resolvedPaths[pathId]) {
                    resolvedEnv.code.push(<TypeScript.SourceUnit>code);
                    this.resolvedPaths[pathId] = true;
                }
            }
        };

        for (var i = 0; i < nCode; i++) {
            path = TypeScript.switchToForwardSlashes(preEnv.ioHost.resolvePath(preEnv.code[i].path));
            this.pathMap[preEnv.code[i].path] = path;
            resolver.resolveCode(path, "", false, resolutionDispatcher);
        }

        return resolvedEnv;
    }
}

class BatchCompiler {
    public compilationSettings: TypeScript.CompilationSettings;
    public compilationEnvironment: TypeScript.CompilationEnvironment;
    public resolvedEnvironment: TypeScript.CompilationEnvironment = null;
    public compilerVersion = "0.8.3.0";
    public printedVersion = false;
    public errorReporter: ErrorReporter = null;

    constructor (public ioHost: IIO) { 
        this.compilationSettings = new TypeScript.CompilationSettings();
        this.compilationEnvironment = new TypeScript.CompilationEnvironment(this.compilationSettings, this.ioHost);
        this.errorReporter = new ErrorReporter(this.ioHost);
    }

    public resolve() {
        var resolver = new TypeScript.CodeResolver(this.compilationEnvironment);
        var commandLineHost = new CommandLineHost(this.compilationSettings, (err) => this.errorReporter.WriteLine(err));
        var ret = commandLineHost.resolveCompilationEnvironment(this.compilationEnvironment, resolver, true);

        for (var i = 0; i < this.compilationEnvironment.code.length; i++) {
            if (!commandLineHost.isResolved(this.compilationEnvironment.code[i].path)) {
                var path = this.compilationEnvironment.code[i].path;
                if (!TypeScript.isSTRFile(path) && !TypeScript.isDSTRFile(path) && !TypeScript.isTSFile(path) && !TypeScript.isDTSFile(path)) {
                    this.errorReporter.WriteLine("Unknown extension for file: \"" + path + "\". Only .ts and .d.ts extensions are allowed.");
                }
                else {
                    this.errorReporter.WriteLine("Error reading file \"" + path + "\": File not found");
                }
            }
        }

        return ret;
    }
    
    /// Do the actual compilation reading from input files and
    /// writing to output file(s).
    public compile(): bool {
        var compiler: TypeScript.TypeScriptCompiler;

        compiler = new TypeScript.TypeScriptCompiler(this.errorReporter, new TypeScript.NullLogger(), this.compilationSettings);
        compiler.setErrorOutput(this.errorReporter);
        compiler.setErrorCallback(
            (minChar, charLen, message, unitIndex) => {
                compiler.errorReporter.hasErrors = true;
                var fname = this.resolvedEnvironment.code[unitIndex].path;
                var lineCol = { line: -1, col: -1 };
                compiler.parser.getSourceLineCol(lineCol, minChar);
                // line is 1-base, col, however, is 0-base. add 1 to the col before printing the message
                var msg = fname + ":" + lineCol.line + ":" + (lineCol.col + 1) + ": error: " + message;
                if (this.compilationSettings.errorRecovery) {
                    this.errorReporter.WriteLine(msg);
                } else {
                    throw new SyntaxError(msg);
                }
            });

        if (this.compilationSettings.emitComments) {
            compiler.emitCommentsToOutput();
        }

        var consumeUnit = (code: TypeScript.SourceUnit, addAsResident: bool) => {
            try {
                // if file resolving is disabled, the file's content will not yet be loaded

                if (!this.compilationSettings.resolve) {
                    code.content = this.ioHost.readFile(code.path);
                    // If declaration files are going to be emitted, 
                    // preprocess the file contents and add in referenced files as well
                    if (this.compilationSettings.generateDeclarationFiles) {
                        TypeScript.CompilerDiagnostics.assert(code.referencedFiles == null, "With no resolve option, referenced files need to null");
                        code.referencedFiles = TypeScript.getReferencedFiles(code);
                    }
                }

                if (code.content != null) {
                    if (this.compilationSettings.parseOnly) {
                        compiler.parseUnit(code.content, code.path);
                    }
                    else {
                        if (this.compilationSettings.errorRecovery) {
                            compiler.parser.setErrorRecovery(this.errorReporter);
                        }
                        compiler.addUnit(code.content, code.path, addAsResident, code.referencedFiles);
                    }
                }
            }
            catch (err) {
                compiler.errorReporter.hasErrors = true;
                // This includes syntax errors thrown from error callback if not in recovery mode
                this.errorReporter.WriteLine(err.message);
            }

        }

        for (var iCode = 0 ; iCode < this.resolvedEnvironment.code.length; iCode++) {
            if (!this.compilationSettings.parseOnly || (iCode > 0)) {
                consumeUnit(this.resolvedEnvironment.code[iCode], false);
            }
        }

        var emitterIOHost = {
            createFile: (fileName: string, useUTF8?: bool) => IOUtils.createFileAndFolderStructure(this.ioHost, fileName, useUTF8),
            directoryExists: this.ioHost.directoryExists,
            fileExists: this.ioHost.fileExists,
            resolvePath: this.ioHost.resolvePath
        };

        try {
            if (!this.compilationSettings.parseOnly) {
                if (!this.compilationSettings.ignoreTypeErrors) {
                    compiler.typeCheck();
                }
                var mapInputToOutput = (unitIndex: number, outFile: string): void => {
                    this.compilationEnvironment.inputOutputMap[unitIndex] = outFile;
                };
                if (!compiler.errorReporter.hasErrors ||
                    !this.compilationSettings.noOutputOnError) {
                    compiler.emit(emitterIOHost, mapInputToOutput);
                    compiler.emitDeclarations();
                }
            }
            else {
                compiler.emitAST(emitterIOHost);
            }
        } catch (err) {
            compiler.errorReporter.hasErrors = true;
            // Catch emitter exceptions
            if (err.message != "EmitError") {
                throw err;
            }
        }

        return compiler.errorReporter.hasErrors;
    }

    // Execute the provided inputs
    public run() {
        for (var i in this.compilationEnvironment.code) {
            var outputFileName: string = this.compilationEnvironment.inputOutputMap[i];
            if (this.ioHost.fileExists(outputFileName)) {
                var unitRes = this.ioHost.readFile(outputFileName)
                this.ioHost.run(unitRes, outputFileName);
            }
        }
    }

    /// Begin batch compilation
    public batchCompile() {
        TypeScript.CompilerDiagnostics.diagnosticWriter = { Alert: (s: string) => { this.ioHost.printLine(s); } }

        var code: TypeScript.SourceUnit;

        var opts = new OptionsParser(this.ioHost);

        opts.option('out', {
            usage: 'Concatenate and emit output to single file | Redirect output structure to the directory',
            type: 'file|directory',
            set: (str) => {
                this.compilationSettings.outputOption = str;
            }
        });

        opts.option('style', {
            usage: 'Select style checking options (examples --style requireSemi:off or --style "eqeqeq;bitwise:off")',
            experimental: true,
            set: (str) => {
                this.compilationSettings.setStyleOptions(str);
            }
        });

        opts.flag('sourcemap', {
            usage: 'Generates corresponding .map file',
            set: () => {
                this.compilationSettings.mapSourceFiles = true;
            }
        });

        opts.flag('fullSourceMapPath', {
            usage: 'Writes the full path of map file in the generated js file',
            experimental: true,
            set: () => {
                this.compilationSettings.emitFullSourceMapPath = true;
            }
        });

        opts.flag('declaration', {
            usage: 'Generates corresponding .d.ts file',
            set: () => {
                this.compilationSettings.generateDeclarationFiles = true;
            }
        });

        if (this.ioHost.watchFile) {
            opts.flag('watch', {
                usage: 'Watch output files',
                set: () => {
                    this.compilationSettings.watch = true;
                }
            }, 'w');
        }

        opts.flag('exec', {
            usage: 'Execute the script after compilation',
            set: () => {
                this.compilationSettings.exec = true;
            }
        }, 'e');

        opts.flag('parse', {
            usage: 'Parse only',
            experimental: true,
            set: () => {
                this.compilationSettings.parseOnly = true;
            }
        });

        opts.flag('minw', {
            usage: 'Minimize whitespace',
            experimental: true,
            set: () => { this.compilationSettings.minWhitespace = true; }
        }, 'mw');

        opts.flag('const', {
            usage: 'Propagate constants to emitted code',
            experimental: true,
            set: () => { this.compilationSettings.propagateConstants = true; }
        });

        opts.flag('errorrecovery', {
            usage: 'Enable error recovery',
            experimental: true,
            set: () => {
                this.compilationSettings.errorRecovery = true;
            }
        }, 'er');

        opts.flag('failonerror', {
            usage: 'Completely fail on type errors (no .js or .d.ts output)',
            set: () => {
                this.compilationSettings.noOutputOnError = true;
            }
        });

        opts.flag('ignoretypeerrors', {
            usage: 'Ignore type errors (exit 0 unless there is a syntax error)',
            set: () => {
                this.compilationSettings.ignoreTypeErrors = true;
            }
        });

        opts.flag('comments', {
            usage: 'Emit comments to output',
            set: () => {
                this.compilationSettings.emitComments = true;
            }
        }, 'c');

        opts.flag('cflow', {
            usage: 'Control flow',
            experimental: true,
            set: () => {
                this.compilationSettings.controlFlow = true;
            }
        });

        opts.flag('cflowp', {
            usage: 'Print control flow',
            experimental: true,
            set: () => {
                this.compilationSettings.controlFlow = true;
                this.compilationSettings.printControlFlow = true;
            }
        });

        opts.flag('cflowu', {
            usage: 'Print Use Def control flow',
            experimental: true,
            set: () => {
                this.compilationSettings.controlFlow = true;
                this.compilationSettings.controlFlowUseDef = true;
            }
        });

        opts.flag('noerroronwith', {
            usage: 'Allow with statements',
            experimental: true,
            set: () => {
                this.compilationSettings.errorOnWith = false;
            }
        });

        opts.flag('noresolve', {
            usage: 'Skip resolution and preprocessing',
            experimental: true,
            set: () => {
                this.compilationSettings.resolve = false;
                this.compilationSettings.preprocess = false;
            }
        });

        opts.flag('debug', {
            usage: 'Print debug output',
            experimental: true,
            set: () => {
                TypeScript.CompilerDiagnostics.debug = true;
            }
        });

        opts.flag('canCallDefinitionSignature', {
            usage: 'Allows you to call the definition signature of an overload group',
            experimental: true,
            set: () => {
                this.compilationSettings.canCallDefinitionSignature = true;
            }
        });

        opts.flag('nooptimizemodules', {
            usage: 'Do not optimize module codegen',
            experimental: true,
            set: () => {
                TypeScript.optimizeModuleCodeGen = false;
            }
        });

        opts.flag('nolib', {
            usage: 'Do not include a default lib.d.ts with global declarations',
            set: () => {
                this.compilationSettings.useDefaultLib = false;
            }
        });


        opts.flag('inferProperties', {
            usage: 'Infer class properties from top-level assignments to \'this\'',
            experimental: true,
            set: () => {
                this.compilationSettings.inferPropertiesFromThisAssignment = true;
            }
        });

        opts.option('target', {
            usage: 'Specify ECMAScript target version: "ES3" (default), or "ES5"',
            type: 'VER',
            set: (type) => {
                type = type.toLowerCase();

                if (type === 'es3') {
                    this.compilationSettings.codeGenTarget = TypeScript.CodeGenTarget.ES3;
                } else if (type === 'es5') {
                    this.compilationSettings.codeGenTarget = TypeScript.CodeGenTarget.ES5;
                }
                else {
                    this.errorReporter.WriteLine("ECMAScript target version '" + type + "' not supported.  Using default 'ES3' code generation");
                }
            }
        });

        opts.option('module', {
            usage: 'Specify module code generation: "commonjs" (default) or "amd"',
            type: 'kind',
            set: (type) => {
                type = type.toLowerCase();

                if (type === 'commonjs' || type === 'node') {
                    TypeScript.moduleGenTarget = TypeScript.ModuleGenTarget.Synchronous;
                } else if (type === 'amd') {
                    TypeScript.moduleGenTarget = TypeScript.ModuleGenTarget.Asynchronous;
                } else {
                    this.errorReporter.WriteLine("Module code generation '" + type + "' not supported.  Using default 'commonjs' code generation");
                }
            }
        });

        var printedUsage = false;

        opts.flag('help', {
            usage: 'Print this message',
            set: () => {
                this.printVersion();
                opts.printUsage();
                printedUsage = true;
            }
        }, 'h');

        opts.flag('useCaseSensitiveFileResolution', {
            usage: 'Force file resolution to be case sensitive',
            experimental: true,
            set: () => {
                this.compilationSettings.useCaseSensitiveFileResolution = true;
            }
        });

        opts.flag('version', {
            usage: 'Print the compiler\'s version: ' + this.compilerVersion,
            set: () => {
                this.printVersion();
            }
        }, 'v');

        opts.parse(this.ioHost.arguments);
        
        if (this.compilationSettings.useDefaultLib) {
            var compilerFilePath = this.ioHost.getExecutingFilePath()
            var binDirPath = this.ioHost.dirName(compilerFilePath);
            var libStrPath = this.ioHost.resolvePath(binDirPath + "/lib.d.ts");
            code = new TypeScript.SourceUnit(libStrPath, null);
            this.compilationEnvironment.code.push(code);
        }

        for (var i = 0; i < opts.unnamed.length; i++) {
            code = new TypeScript.SourceUnit(opts.unnamed[i], null);
            this.compilationEnvironment.code.push(code);
        }

        // If no source files provided to compiler - print usage information
        if (this.compilationEnvironment.code.length == (this.compilationSettings.useDefaultLib ? 1 : 0)) {
            if (!printedUsage && !this.printedVersion) {
                this.printVersion();
                opts.printUsage();
                this.ioHost.quit(1);
            }
            return;
        }

        var sourceFiles: TypeScript.SourceUnit[] = [];
        if (this.compilationSettings.watch) {
            // Capture the state before calling resolve
            sourceFiles = this.compilationEnvironment.code.slice(0);
        }

        // Resolve file dependencies, if requested
        this.resolvedEnvironment = this.compilationSettings.resolve ? this.resolve() : this.compilationEnvironment;

        this.compile();

        if (!this.errorReporter.hasErrors) {
            if (this.compilationSettings.exec) {
                this.run();
            }
        }

        if (this.compilationSettings.watch) {
            // Watch will cause the program to stick around as long as the files exist
            this.watchFiles(sourceFiles);
        }
        else {  
            // Exit with the appropriate error code
            this.ioHost.quit(this.errorReporter.hasErrors ? 1 : 0);
        }
    }

    public printVersion() {
        if (!this.printedVersion) {
            this.ioHost.printLine("Version " + this.compilerVersion);
            this.printedVersion = true;
        }
    }

    public watchFiles(soruceFiles: TypeScript.SourceUnit[]) {
        if (!this.ioHost.watchFile) {
            this.errorReporter.WriteLine("Error: Current host does not support -w[atch] option");
            return;
        }

        var resolvedFiles: string[] = []
        var watchers: { [x: string]: IFileWatcher; } = {};

        var addWatcher = (filename: string) => {
            if (!watchers[filename]) {
                var watcher = this.ioHost.watchFile(filename, onWatchedFileChange);
                watchers[filename] = watcher;
            }
            else {
                TypeScript.CompilerDiagnostics.debugPrint("Cannot watch file, it is already watched.");
            }
        };

        var removeWatcher = (filename: string) => {
            if (watchers[filename]) {
                watchers[filename].close();
                delete watchers[filename];
            }
            else {
                TypeScript.CompilerDiagnostics.debugPrint("Cannot stop watching file, it is not being watched.");
            }
        };

        var onWatchedFileChange = () => {
            // Reset the state
            this.compilationEnvironment.code = soruceFiles;

            // Clean errors for previous compilation
            this.errorReporter.reset();

            // Resolve file dependencies, if requested
            this.resolvedEnvironment = this.compilationSettings.resolve ? this.resolve() : this.compilationEnvironment;

            // Check if any new files were added to the environment as a result of the file change
            var oldFiles = resolvedFiles;
            var newFiles: string[] = [];
            this.resolvedEnvironment.code.forEach((sf) => newFiles.push(sf.path));
            newFiles = newFiles.sort();

            var i = 0, j = 0;
            while (i < oldFiles.length && j < newFiles.length) {

                var compareResult = oldFiles[i].localeCompare(newFiles[j]);
                if (compareResult == 0) {
                    // No change here
                    i++;
                    j++;
                }
                else if (compareResult < 0) {
                    // Entry in old list does not exist in the new one, it was removed
                    removeWatcher(oldFiles[i]);
                    i++;
                }
                else {
                    // Entry in new list does exist in the new one, it was added
                    addWatcher(newFiles[j]);
                    j++;
                }
            }

            // All remaining unmatched items in the old list have been removed
            for (var k = i; k < oldFiles.length; k++) {
                removeWatcher(oldFiles[k]);
            }

            // All remaing unmatched items in the new list have been added
            for (var k = j; k < newFiles.length; k++) {
                addWatcher(newFiles[k]);
            }

            // Update the state
            resolvedFiles = newFiles;;

            // Print header
            this.ioHost.printLine("");
            this.ioHost.printLine("Recompiling (" + new Date() + "): ");
            resolvedFiles.forEach((f) => this.ioHost.printLine("    " + f));

            // Trigger a new compilation
            this.compile();

            if (!this.errorReporter.hasErrors) {
                if (this.compilationSettings.exec) {
                    this.run();
                }
            }
        };

        // Switch to using stdout for all error messages
        this.ioHost.stderr = this.ioHost.stdout;

        // Initialize the initial list of resolved files, and add watches to them
        this.resolvedEnvironment.code.forEach((sf) => {
            resolvedFiles.push(sf.path);
            addWatcher(sf.path);
        });
        resolvedFiles.sort();
    }
}

// Start the batch compilation using the current hosts IO
var batch = new BatchCompiler(IO);
batch.batchCompile();
