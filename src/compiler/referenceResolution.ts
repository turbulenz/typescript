﻿//﻿
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

///<reference path='typescript.ts' />

module TypeScript {

    export interface IResolvedFile {
        content: string;
        path: string;
    }

    /// This class acts as a convenience class to store path and content information in places
    /// where we need an ISourceText object
    export class SourceUnit implements IScriptSnapshot, IResolvedFile {
        public referencedFiles: IFileReference[] = null;
        private lineStarts: number[] = null;

        constructor(public path: string,
                    public content: string) {
        }

        public getText(start: number, end: number): string {
            return this.content.substring(start, end);
        }

        public getLength(): number {
            return this.content.length;
        }

        public getLineStartPositions(): number[]{
            if (this.lineStarts === null) {
                this.lineStarts = LineMap.createFromString(this.content).lineStarts();
            }

            return this.lineStarts;
        }

        public getTextChangeRangeSinceVersion(scriptVersion: number): TypeScript.TextChangeRange {
            throw Errors.notYetImplemented();
        }
    }

    export interface IFileReference extends ILineAndCharacter {
        path: string;
        isResident: bool;
    }

    /// Limited API for file system manipulation
    export interface IFileSystemObject {
        resolvePath(path: string): string;
        readFile(path: string): string;
        findFile(rootPath: string, partialFilePath: string): IResolvedFile;
        dirName(path: string): string;
    }

    export class CompilationEnvironment {
        constructor (public compilationSettings: CompilationSettings, public ioHost: IFileSystemObject) { }
        public code: SourceUnit[] = [];
        public inputFileNameToOutputFileName = new StringHashTable();
    }

    export interface IResolutionDispatcher {
        postResolutionError(errorFile: string, fileReference: IFileReference, errorMessage: string): void;
        postResolution(path: string, source: IScriptSnapshot): void;
    }

    export interface ICodeResolver {
        resolveCode(referencePath: string, rootPath: string, performSearch:bool, state: IResolutionDispatcher): void;
    }

    export interface IResolverHost {
        resolveCompilationEnvironment(preEnvironment: CompilationEnvironment, resolver: ICodeResolver, traceDependencies: bool): CompilationEnvironment;
    }

    export class CodeResolver implements TypeScript.ICodeResolver {
        public visited: any = { };

        constructor (public environment: CompilationEnvironment) { }

        public resolveCode(referencePath: string, parentPath: string, performSearch: bool, resolutionDispatcher: TypeScript.IResolutionDispatcher): bool {
            
            var resolvedFile: IResolvedFile = { content: null, path: referencePath };
            
            var ioHost = this.environment.ioHost;
            
            // If the path is relative, normalize it, based on the root
            var isRelativePath = TypeScript.isRelative(referencePath);
            var isRootedPath = isRelativePath ? false : isRooted(referencePath);
            var normalizedPath: string = 
                isRelativePath ? ioHost.resolvePath(parentPath + "/" + referencePath) : 
                // we only follow the second clause if the path is a non-rooted triple-slash reference path
                (isRootedPath || !parentPath || performSearch ? referencePath : parentPath + "/" + referencePath);

            // We use +=.ts to make sure we don't accidentally pick up ".js" files or the like
            if (!isSTRFile(normalizedPath) && !isTSFile(normalizedPath)) {
                normalizedPath += ".ts";  //changePathToSTR(normalizedPath);
            }

            normalizedPath = switchToForwardSlashes(stripQuotes(normalizedPath));
            var absoluteModuleID = this.environment.compilationSettings.useCaseSensitiveFileResolution ? normalizedPath : normalizedPath.toLocaleUpperCase();
            // read the file contents - if it doesn't exist, trigger a resolution error
            if (!this.visited[absoluteModuleID]) {

                // if the path is relative, or came from a reference tag, we don't perform a search
                if (isRelativePath || isRootedPath || !performSearch) {
                    try {
                        CompilerDiagnostics.debugPrint("   Reading code from " + normalizedPath);
                            
                        // Look for the .ts file first - if not present, use the .ts, the .d.str and the .d.ts
                        try {
                            resolvedFile.content = ioHost.readFile(normalizedPath);
                        }
                        catch (err1) {
                            try {
                                if (isSTRFile(normalizedPath)) {
                                    normalizedPath = changePathToTS(normalizedPath);
                                }
                                else if (isTSFile(normalizedPath)) {
                                    normalizedPath = changePathToSTR(normalizedPath);
                                }
                                CompilerDiagnostics.debugPrint("   Reading code from " + normalizedPath);
                                resolvedFile.content = ioHost.readFile(normalizedPath);
                            }
                            catch (err2) {
                                normalizedPath = changePathToDSTR(normalizedPath);
                                CompilerDiagnostics.debugPrint("   Reading code from " + normalizedPath);

                                try {
                                    resolvedFile.content = ioHost.readFile(normalizedPath);
                                }
                                catch (err3) {
                                    normalizedPath = changePathToDTS(normalizedPath);
                                    CompilerDiagnostics.debugPrint("   Reading code from " + normalizedPath);
                                    resolvedFile.content = ioHost.readFile(normalizedPath);
                                }
                            }
                        }
                        CompilerDiagnostics.debugPrint("   Found code at " + normalizedPath);

                        resolvedFile.path = normalizedPath;
                        this.visited[absoluteModuleID] = true;
                    }
                    catch (err4) {
                        CompilerDiagnostics.debugPrint("   Did not find code for " + referencePath);
                        // Resolution failed
                        return false;
                    }
                }
                else {

                    // if the path is non-relative, we should attempt to search on the relative path
                    resolvedFile = ioHost.findFile(parentPath, normalizedPath);

                    if (!resolvedFile) {
                        if (isSTRFile(normalizedPath)) {
                            normalizedPath = changePathToTS(normalizedPath);
                        }
                        else if (isTSFile(normalizedPath)) {
                            normalizedPath = changePathToSTR(normalizedPath);
                        }
                        resolvedFile = ioHost.findFile(parentPath, normalizedPath);
                    }

                    if (!resolvedFile) {
                        normalizedPath = changePathToDTS(normalizedPath);
                        resolvedFile = ioHost.findFile(parentPath, normalizedPath);
                        if (!resolvedFile) {
                            normalizedPath = changePathToDSTR(normalizedPath);
                            resolvedFile = ioHost.findFile(parentPath, normalizedPath);
                        }
                    }

                    if (resolvedFile) {
                        resolvedFile.path = switchToForwardSlashes(TypeScript.stripQuotes(resolvedFile.path));
                        CompilerDiagnostics.debugPrint(referencePath + " resolved to: " + resolvedFile.path);
                        resolvedFile.content = resolvedFile.content;
                        this.visited[absoluteModuleID] = true;
                    }
                    else {
                        CompilerDiagnostics.debugPrint("Could not find " + referencePath);
                    }
                }

                if (resolvedFile && resolvedFile.content != null) {
                    // preprocess the file, to gather dependencies
                    var rootDir = ioHost.dirName(resolvedFile.path);
                    var sourceUnit = new SourceUnit(resolvedFile.path, resolvedFile.content);
                    var preProcessedFileInfo = preProcessFile(sourceUnit, this.environment.compilationSettings);
                    var resolvedFilePath = ioHost.resolvePath(resolvedFile.path);
                    var i = 0;
                    var resolutionResult: bool;

                    sourceUnit.referencedFiles = preProcessedFileInfo.referencedFiles;

                    // resolve explicit references
                    for (i = 0; i < preProcessedFileInfo.referencedFiles.length; i++) {
                        var fileReference = preProcessedFileInfo.referencedFiles[i];

                        normalizedPath = isRooted(fileReference.path) ? fileReference.path : rootDir + "/" + fileReference.path;
                        normalizedPath = ioHost.resolvePath(normalizedPath);

                        if (resolvedFilePath == normalizedPath) {
                            resolutionDispatcher.postResolutionError(normalizedPath, fileReference, "Incorrect reference: File contains reference to itself.");
                            continue;
                        }

                        resolutionResult = this.resolveCode(fileReference.path, rootDir, false, resolutionDispatcher);

                        if (!resolutionResult) {
                            resolutionDispatcher.postResolutionError(resolvedFilePath, fileReference, "Incorrect reference: referenced file: \"" + fileReference.path + "\" cannot be resolved.");
                        }
                    }
                    
                    // resolve imports
                    for (i = 0; i < preProcessedFileInfo.importedFiles.length; i++) {
                        var fileImport = preProcessedFileInfo.importedFiles[i];

                        resolutionResult = this.resolveCode(fileImport.path, rootDir, true, resolutionDispatcher);

                        if (!resolutionResult) {
                            resolutionDispatcher.postResolutionError(resolvedFilePath, fileImport, "Incorrect reference: imported file: \"" + fileImport.path + "\" cannot be resolved.");
                        }
                    }

                    // add the file to the appropriate code list
                    resolutionDispatcher.postResolution(sourceUnit.path, sourceUnit);
                }
            }
            return true;
        }
    }
}