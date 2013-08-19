//
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
    export class TextWriter implements ITextWriter {
        private contents = "";
        public onNewLine = true;
        constructor(private ioHost: EmitterIOHost, private path: string, private writeByteOrderMark: boolean) {
        }

        public Write(s: string) {
            this.contents += s;
            this.onNewLine = false;
        }

        public WriteLine(s: string) {
            this.contents += s;
            this.contents += TypeScript.newLine();
            this.onNewLine = true;
        }

        public Close() {
            try {
                this.ioHost.writeFile(this.path, this.contents, this.writeByteOrderMark);
            }
            catch (e) {
                Emitter.throwEmitterError(e);
            }
        }
    }

    export class DeclarationEmitter {
        private declFile: TextWriter = null;
        private indenter = new Indenter();
        private declarationContainerStack: AST[] = [];
        private isDottedModuleName: boolean[] = [];
        private dottedModuleEmit: string;
        private ignoreCallbackAst: AST = null;
        private varListCount: number = 0;
        private emittedReferencePaths = false;

        constructor(private emittingFileName: string, public document: Document, private compiler: TypeScriptCompiler) {
            this.declFile = new TextWriter(this.compiler.emitOptions.ioHost, emittingFileName, this.document.byteOrderMark !== ByteOrderMark.None);
        }

        public widenType(type: PullTypeSymbol) {
            if (type === this.compiler.semanticInfoChain.undefinedTypeSymbol || type === this.compiler.semanticInfoChain.nullTypeSymbol) {
                return this.compiler.semanticInfoChain.anyTypeSymbol;
            }

            return type;
        }

        public close() {
            try {
                this.declFile.Close();
            }
            catch (e) {
                Emitter.throwEmitterError(e);
            }
        }

        public emitDeclarations(script: TypeScript.Script): void {
            var walk = (pre: boolean, ast: AST): boolean => {
                switch (ast.nodeType()) {
                    case NodeType.VariableStatement:
                        return this.variableStatementCallback(pre, <VariableStatement>ast);
                    case NodeType.VariableDeclaration:
                        return this.variableDeclarationCallback(pre, <VariableDeclaration>ast);
                    case NodeType.VariableDeclarator:
                        return this.variableDeclaratorCallback(pre, <VariableDeclarator>ast);
                    case NodeType.Block:
                        return this.blockCallback(pre, <Block>ast);
                    case NodeType.FunctionDeclaration:
                        return this.functionDeclarationCallback(pre, <FunctionDeclaration>ast);
                    case NodeType.ClassDeclaration:
                        return this.classDeclarationCallback(pre, <ClassDeclaration>ast);
                    case NodeType.InterfaceDeclaration:
                        return this.interfaceDeclarationCallback(pre, <InterfaceDeclaration>ast);
                    case NodeType.ImportDeclaration:
                        return this.importDeclarationCallback(pre, <ImportDeclaration>ast);
                    case NodeType.ModuleDeclaration:
                        return this.moduleDeclarationCallback(pre, <ModuleDeclaration>ast);
                    case NodeType.ExportAssignment:
                        return this.exportAssignmentCallback(pre, <ExportAssignment>ast);
                    case NodeType.Script:
                        return this.scriptCallback(pre, <Script>ast);
                    default:
                        return this.defaultCallback(pre, ast);
                }
            };

            getAstWalkerFactory().walk(script,
                (ast: AST, parent: AST, walker: IAstWalker): AST => { walker.options.goChildren = walk(/*pre*/true, ast); return ast; },
                (ast: AST, parent: AST, walker: IAstWalker): AST => { walker.options.goChildren = walk(/*pre*/false, ast); return ast; });
        }

        public getAstDeclarationContainer() {
            return this.declarationContainerStack[this.declarationContainerStack.length - 1];
        }

        private emitDottedModuleName() {
            return (this.isDottedModuleName.length === 0) ? false : this.isDottedModuleName[this.isDottedModuleName.length - 1];
        }

        private getIndentString(declIndent = false) {
            return this.indenter.getIndent();
        }

        private emitIndent() {
            this.declFile.Write(this.getIndentString());
        }

        private canEmitSignature(declFlags: DeclFlags, declAST: AST, canEmitGlobalAmbientDecl: boolean = true, useDeclarationContainerTop: boolean = true) {
            var container: AST;
            if (useDeclarationContainerTop) {
                container = this.getAstDeclarationContainer();
            }
            else {
                container = this.declarationContainerStack[this.declarationContainerStack.length - 2];
            }

            var pullDecl = this.compiler.semanticInfoChain.getDeclForAST(declAST, this.document.fileName);
            if (container.nodeType() === NodeType.ModuleDeclaration) {
                if (!hasFlag(pullDecl.flags, PullElementFlags.Exported)) {
                    var start = new Date().getTime();
                    var declSymbol = this.compiler.semanticInfoChain.getSymbolForAST(declAST, this.document.fileName);
                    var result = declSymbol && declSymbol.isExternallyVisible();
                    TypeScript.declarationEmitIsExternallyVisibleTime += new Date().getTime() - start;

                    return result;
                }
            }

            if (!canEmitGlobalAmbientDecl && container.nodeType() === NodeType.Script && hasFlag(pullDecl.flags, PullElementFlags.Ambient)) {
                return false;
            }

            return true;
        }

        private canEmitPrePostAstSignature(declFlags: DeclFlags, astWithPrePostCallback: AST, preCallback: boolean) {
            if (this.ignoreCallbackAst) {
                CompilerDiagnostics.assert(this.ignoreCallbackAst !== astWithPrePostCallback, "Ignore Callback AST mismatch");
                this.ignoreCallbackAst = null;
                return false;
            }
            else if (preCallback &&
                !this.canEmitSignature(declFlags, astWithPrePostCallback, true, preCallback)) {
                this.ignoreCallbackAst = astWithPrePostCallback;
                return false;
            }

            return true;
        }

        private getDeclFlagsString(declFlags: DeclFlags, pullDecl: PullDecl, typeString: string) {
            var result = this.getIndentString();
            var pullFlags = pullDecl.flags;

            // Static/public/private/global declare
            if (hasFlag(declFlags, DeclFlags.Static)) {
                if (hasFlag(declFlags, DeclFlags.Private)) {
                    result += "private ";
                }
                result += "static ";
            }
            else {
                if (hasFlag(declFlags, DeclFlags.Private)) {
                    result += "private ";
                }
                else if (hasFlag(declFlags, DeclFlags.Public)) {
                    result += "public ";
                }
                else {
                    var emitDeclare = !hasFlag(pullFlags, PullElementFlags.Exported);

                    // Emit export only for global export statements. 
                    // The container for this would be dynamic module which is whole file
                    var container = this.getAstDeclarationContainer();
                    if (container.nodeType() === NodeType.ModuleDeclaration &&
                        hasFlag((<ModuleDeclaration>container).getModuleFlags(), ModuleFlags.IsWholeFile) &&
                        hasFlag(pullFlags, PullElementFlags.Exported)) {
                        result += "export ";
                        emitDeclare = true;
                    }

                    // Emit declare if not interface declaration or import declaration && is not from module
                    if (emitDeclare && typeString !== "interface" && typeString != "import") {
                        result += "declare ";
                    }

                    result += typeString + " ";
                }
            }

            return result;
        }

        private emitDeclFlags(declFlags: DeclFlags, pullDecl: PullDecl, typeString: string) {
            this.declFile.Write(this.getDeclFlagsString(declFlags, pullDecl, typeString));
        }

        private canEmitTypeAnnotationSignature(declFlag: DeclFlags = DeclFlags.None) {
            // Private declaration, shouldnt emit type any time.
            return !hasFlag(declFlag, DeclFlags.Private);
        }

        private pushDeclarationContainer(ast: AST) {
            this.declarationContainerStack.push(ast);
        }

        private popDeclarationContainer(ast: AST) {
            CompilerDiagnostics.assert(ast !== this.getAstDeclarationContainer(), 'Declaration container mismatch');
            this.declarationContainerStack.pop();
        }

        public emitTypeNamesMember(memberName: MemberName, emitIndent: boolean = false) {
            if (memberName.prefix === "{ ") {
                if (emitIndent) {
                    this.emitIndent();
                }

                this.declFile.WriteLine("{");
                this.indenter.increaseIndent();
                emitIndent = true;
            }
            else if (memberName.prefix !== "") {
                if (emitIndent) {
                    this.emitIndent();
                }

                this.declFile.Write(memberName.prefix);
                emitIndent = false;
            }

            if (memberName.isString()) {
                if (emitIndent) {
                    this.emitIndent();
                }

                this.declFile.Write((<MemberNameString>memberName).text);
            }
            else if (memberName.isArray()) {
                var ar = <MemberNameArray>memberName;
                for (var index = 0; index < ar.entries.length; index++) {
                    this.emitTypeNamesMember(ar.entries[index], emitIndent);
                    if (ar.delim === "; ") {
                        this.declFile.WriteLine(";");
                    }
                }
            }

            if (memberName.suffix === "}") {
                this.indenter.decreaseIndent();
                this.emitIndent();
                this.declFile.Write(memberName.suffix);
            }
            else {
                this.declFile.Write(memberName.suffix);
            }
        }

        private emitTypeSignature(type: PullTypeSymbol) {
            var declarationContainerAst = this.getAstDeclarationContainer();

            var start = new Date().getTime();
            var declarationContainerDecl = this.compiler.semanticInfoChain.getDeclForAST(declarationContainerAst, this.document.fileName);
            var declarationPullSymbol = declarationContainerDecl.getSymbol();
            TypeScript.declarationEmitTypeSignatureTime += new Date().getTime() - start;

            var typeNameMembers = type.getScopedNameEx(declarationPullSymbol);
            this.emitTypeNamesMember(typeNameMembers);
        }

        private emitComment(comment: Comment) {
            var text = comment.getText();
            if (this.declFile.onNewLine) {
                this.emitIndent();
            }
            else if (!comment.isBlockComment) {
                this.declFile.WriteLine("");
                this.emitIndent();
            }

            this.declFile.Write(text[0]);

            for (var i = 1; i < text.length; i++) {
                this.declFile.WriteLine("");
                this.emitIndent();
                this.declFile.Write(text[i]);
            }

            if (comment.endsLine || !comment.isBlockComment) {
                this.declFile.WriteLine("");
            }
            else {
                this.declFile.Write(" ");
            }
        }

        private emitDeclarationComments(ast: AST, endLine?: boolean): void;
        private emitDeclarationComments(astOrSymbol: any, endLine = true) {
            if (this.compiler.emitOptions.compilationSettings.removeComments) {
                return;
            }

            var declComments = <Comment[]>astOrSymbol.docComments();
            this.writeDeclarationComments(declComments, endLine);
        }

        public writeDeclarationComments(declComments: Comment[], endLine = true) {
            if (declComments.length > 0) {
                for (var i = 0; i < declComments.length; i++) {
                    this.emitComment(declComments[i]);
                }

                if (endLine) {
                    if (!this.declFile.onNewLine) {
                        this.declFile.WriteLine("");
                    }
                }
                else {
                    if (this.declFile.onNewLine) {
                        this.emitIndent();
                    }
                }
            }
        }

        public emitTypeOfBoundDecl(boundDecl: BoundDecl) {
            var start = new Date().getTime();
            var decl = this.compiler.semanticInfoChain.getDeclForAST(boundDecl, this.document.fileName);
            var pullSymbol = decl.getSymbol();
            TypeScript.declarationEmitGetBoundDeclTypeTime += new Date().getTime() - start;

            var type = this.widenType(pullSymbol.type);
            if (!type) {
                // PULLTODO
                return;
            }

            if (boundDecl.typeExpr || // Specified type expression
                (boundDecl.init && type !== this.compiler.semanticInfoChain.anyTypeSymbol)) { // Not infered any
                this.declFile.Write(": ");
                this.emitTypeSignature(type);
            }

        }

        private variableDeclaratorCallback(pre: boolean, varDecl: VariableDeclarator): boolean {
            if (pre && this.canEmitSignature(ToDeclFlags(varDecl.getVarFlags()), varDecl, false)) {
                var interfaceMember = (this.getAstDeclarationContainer().nodeType() === NodeType.InterfaceDeclaration);
                this.emitDeclarationComments(varDecl);
                if (!interfaceMember) {
                    // If it is var list of form var a, b, c = emit it only if count > 0 - which will be when emitting first var
                    // If it is var list of form  var a = varList count will be 0
                    if (this.varListCount >= 0) {
                        this.emitDeclFlags(ToDeclFlags(varDecl.getVarFlags()), this.compiler.semanticInfoChain.getDeclForAST(varDecl, this.document.fileName), "var");
                        this.varListCount = -this.varListCount;
                    }

                    this.declFile.Write(varDecl.id.actualText);
                }
                else {
                    this.emitIndent();
                    this.declFile.Write(varDecl.id.actualText);
                    if (hasFlag(varDecl.id.getFlags(), ASTFlags.OptionalName)) {
                        this.declFile.Write("?");
                    }
                }

                if (this.canEmitTypeAnnotationSignature(ToDeclFlags(varDecl.getVarFlags()))) {
                    this.emitTypeOfBoundDecl(varDecl);
                }

                // emitted one var decl
                if (this.varListCount > 0) {
                    this.varListCount--;
                }
                else if (this.varListCount < 0) {
                    this.varListCount++;
                }

                // Write ; or ,
                if (this.varListCount < 0) {
                    this.declFile.Write(", ");
                }
                else {
                    this.declFile.WriteLine(";");
                }
            }
            return false;
        }

        private blockCallback(pre: boolean, block: Block): boolean {
            return false;
        }

        private variableStatementCallback(pre: boolean, variableStatement: VariableStatement): boolean {
            return true;
        }

        private variableDeclarationCallback(pre: boolean, variableDeclaration: VariableDeclaration): boolean {
            if (pre) {
                this.varListCount = variableDeclaration.declarators.members.length;
            }
            else {
                this.varListCount = 0;
            }

            return true;
        }

        private emitArgDecl(argDecl: Parameter, funcDecl: FunctionDeclaration) {
            this.indenter.increaseIndent();

            this.emitDeclarationComments(argDecl, false);
            this.declFile.Write(argDecl.id.actualText);
            if (argDecl.isOptionalArg()) {
                this.declFile.Write("?");
            }

            this.indenter.decreaseIndent();

            if (this.canEmitTypeAnnotationSignature(ToDeclFlags(funcDecl.getFunctionFlags()))) {
                this.emitTypeOfBoundDecl(argDecl);
            }
        }

        public isOverloadedCallSignature(funcDecl: FunctionDeclaration) {
            var start = new Date().getTime();
            var functionDecl = this.compiler.semanticInfoChain.getDeclForAST(funcDecl, this.document.fileName);
            var funcSymbol = functionDecl.getSymbol();
            TypeScript.declarationEmitIsOverloadedCallSignatureTime += new Date().getTime() - start;

            var funcTypeSymbol = funcSymbol.type;
            var signatures = funcTypeSymbol.getCallSignatures();
            var result = signatures && signatures.length > 1;

            return result;
        }

        private functionDeclarationCallback(pre: boolean, funcDecl: FunctionDeclaration): boolean {
            if (!pre) {
                return false;
            }

            if (funcDecl.isAccessor()) {
                return this.emitPropertyAccessorSignature(funcDecl);
            }

            var isInterfaceMember = (this.getAstDeclarationContainer().nodeType() === NodeType.InterfaceDeclaration);

            var start = new Date().getTime();
            var funcSymbol = this.compiler.semanticInfoChain.getSymbolForAST(funcDecl, this.document.fileName);

            TypeScript.declarationEmitFunctionDeclarationGetSymbolTime += new Date().getTime() - start;

            var funcTypeSymbol = funcSymbol.type;
            if (funcDecl.block) {
                var constructSignatures = funcTypeSymbol.getConstructSignatures();
                if (constructSignatures && constructSignatures.length > 1) {
                    return false;
                }
                else if (this.isOverloadedCallSignature(funcDecl)) {
                    // This means its implementation of overload signature. do not emit
                    return false;
                }
            }
            else if (!isInterfaceMember && hasFlag(funcDecl.getFunctionFlags(), FunctionFlags.Private) && this.isOverloadedCallSignature(funcDecl)) {
                // Print only first overload of private function
                var callSignatures = funcTypeSymbol.getCallSignatures();
                Debug.assert(callSignatures && callSignatures.length > 1);
                var firstSignature = callSignatures[0].isDefinition() ? callSignatures[1] : callSignatures[0];
                var firstSignatureDecl = firstSignature.getDeclarations()[0];
                var firstFuncDecl = <FunctionDeclaration>this.compiler.semanticInfoChain.getASTForDecl(firstSignatureDecl);
                if (firstFuncDecl !== funcDecl) {
                    return false;
                }
            }

            if (!this.canEmitSignature(ToDeclFlags(funcDecl.getFunctionFlags()), funcDecl, false)) {
                return false;
            }

            var funcPullDecl = this.compiler.semanticInfoChain.getDeclForAST(funcDecl, this.document.fileName);
            var funcSignature = funcPullDecl.getSignatureSymbol();
            this.emitDeclarationComments(funcDecl);
            if (funcDecl.isConstructor) {
                this.emitIndent();
                this.declFile.Write("constructor");
                this.emitTypeParameters(funcDecl.typeArguments, funcSignature);
            }
            else {
                var id = funcDecl.getNameText();
                if (!isInterfaceMember) {
                    this.emitDeclFlags(ToDeclFlags(funcDecl.getFunctionFlags()), funcPullDecl, "function");
                    if (id !== "__missing" || !funcDecl.name || !funcDecl.name.isMissing()) {
                        this.declFile.Write(id);
                    }
                    else if (funcDecl.isConstructMember()) {
                        this.declFile.Write("new");
                    }

                    this.emitTypeParameters(funcDecl.typeArguments, funcSignature);
                }
                else {
                    this.emitIndent();
                    if (funcDecl.isConstructMember()) {
                        this.declFile.Write("new");
                        this.emitTypeParameters(funcDecl.typeArguments, funcSignature);
                    }
                    else if (!funcDecl.isCallMember() && !funcDecl.isIndexerMember()) {
                        this.declFile.Write(id);
                        this.emitTypeParameters(funcDecl.typeArguments, funcSignature);
                        if (hasFlag(funcDecl.name.getFlags(), ASTFlags.OptionalName)) {
                            this.declFile.Write("? ");
                        }
                    }
                    else {
                        this.emitTypeParameters(funcDecl.typeArguments, funcSignature);
                    }
                }
            }

            if (!funcDecl.isIndexerMember()) {
                this.declFile.Write("(");
            }
            else {
                this.declFile.Write("[");
            }

            if (funcDecl.arguments) {
                var argsLen = funcDecl.arguments.members.length;
                if (funcDecl.variableArgList) {
                    argsLen--;
                }

                for (var i = 0; i < argsLen; i++) {
                    var argDecl = <Parameter>funcDecl.arguments.members[i];
                    this.emitArgDecl(argDecl, funcDecl);
                    if (i < (argsLen - 1)) {
                        this.declFile.Write(", ");
                    }
                }
            }

            if (funcDecl.variableArgList) {
                var lastArg = <Parameter>funcDecl.arguments.members[funcDecl.arguments.members.length - 1];
                if (funcDecl.arguments.members.length > 1) {
                    this.declFile.Write(", ...");
                }
                else {
                    this.declFile.Write("...");
                }

                this.emitArgDecl(lastArg, funcDecl);
            }

            if (!funcDecl.isIndexerMember()) {
                this.declFile.Write(")");
            }
            else {
                this.declFile.Write("]");
            }

            if (!funcDecl.isConstructor &&
                this.canEmitTypeAnnotationSignature(ToDeclFlags(funcDecl.getFunctionFlags()))) {
                var returnType = funcSignature.returnType;
                if (funcDecl.returnTypeAnnotation ||
                    (returnType && returnType !== this.compiler.semanticInfoChain.anyTypeSymbol)) {
                    this.declFile.Write(": ");
                    this.emitTypeSignature(returnType);
                }
            }

            this.declFile.WriteLine(";");

            return false;
        }

        public emitBaseExpression(bases: ASTList, index: number) {
            var start = new Date().getTime();
            var baseTypeAndDiagnostics = this.compiler.semanticInfoChain.getSymbolForAST(bases.members[index], this.document.fileName);
            TypeScript.declarationEmitGetBaseTypeTime += new Date().getTime() - start;

            var baseType = baseTypeAndDiagnostics && <PullTypeSymbol>baseTypeAndDiagnostics;
            this.emitTypeSignature(baseType);
        }

        private emitBaseList(typeDecl: TypeDeclaration, useExtendsList: boolean) {
            var bases = useExtendsList ? typeDecl.extendsList : typeDecl.implementsList;
            if (bases && (bases.members.length > 0)) {
                var qual = useExtendsList ? "extends" : "implements";
                this.declFile.Write(" " + qual + " ");
                var basesLen = bases.members.length;
                for (var i = 0; i < basesLen; i++) {
                    if (i > 0) {
                        this.declFile.Write(", ");
                    }
                    this.emitBaseExpression(bases, i);
                }
            }
        }

        private emitAccessorDeclarationComments(funcDecl: FunctionDeclaration) {
            if (this.compiler.emitOptions.compilationSettings.removeComments) {
                return;
            }

            var start = new Date().getTime();
            var accessors = PullHelpers.getGetterAndSetterFunction(funcDecl, this.compiler.semanticInfoChain, this.document.fileName);
            TypeScript.declarationEmitGetAccessorFunctionTime += new Date().getTime();

            var comments: Comment[] = [];
            if (accessors.getter) {
                comments = comments.concat(accessors.getter.docComments());
            }
            if (accessors.setter) {
                comments = comments.concat(accessors.setter.docComments());
            }

            this.writeDeclarationComments(comments);
        }

        public emitPropertyAccessorSignature(funcDecl: FunctionDeclaration) {
            var start = new Date().getTime();
            var accessorSymbol = PullHelpers.getAccessorSymbol(funcDecl, this.compiler.semanticInfoChain, this.document.fileName);
            TypeScript.declarationEmitGetAccessorFunctionTime += new Date().getTime();

            if (!hasFlag(funcDecl.getFunctionFlags(), FunctionFlags.GetAccessor) && accessorSymbol.getGetter()) {
                // Setter is being used to emit the type info. 
                return false;
            }

            this.emitAccessorDeclarationComments(funcDecl);
            this.emitDeclFlags(ToDeclFlags(funcDecl.getFunctionFlags()), this.compiler.semanticInfoChain.getDeclForAST(funcDecl, this.document.fileName), "var");
            this.declFile.Write(funcDecl.name.actualText);
            if (this.canEmitTypeAnnotationSignature(ToDeclFlags(funcDecl.getFunctionFlags()))) {
                this.declFile.Write(" : ");
                var type = accessorSymbol.type;
                this.emitTypeSignature(type);
            }
            this.declFile.WriteLine(";");

            return false;
        }

        private emitClassMembersFromConstructorDefinition(funcDecl: FunctionDeclaration) {
            if (funcDecl.arguments) {
                var argsLen = funcDecl.arguments.members.length;
                if (funcDecl.variableArgList) {
                    argsLen--;
                }

                for (var i = 0; i < argsLen; i++) {
                    var argDecl = <Parameter>funcDecl.arguments.members[i];
                    if (hasFlag(argDecl.getVarFlags(), VariableFlags.Property)) {
                        var funcPullDecl = this.compiler.semanticInfoChain.getDeclForAST(funcDecl, this.document.fileName);
                        this.emitDeclarationComments(argDecl);
                        this.emitDeclFlags(ToDeclFlags(argDecl.getVarFlags()), funcPullDecl, "var");
                        this.declFile.Write(argDecl.id.actualText);

                        if (this.canEmitTypeAnnotationSignature(ToDeclFlags(argDecl.getVarFlags()))) {
                            this.emitTypeOfBoundDecl(argDecl);
                        }
                        this.declFile.WriteLine(";");
                    }
                }
            }
        }

        private classDeclarationCallback(pre: boolean, classDecl: ClassDeclaration): boolean {
            if (!this.canEmitPrePostAstSignature(ToDeclFlags(classDecl.getVarFlags()), classDecl, pre)) {
                return false;
            }

            if (pre) {
                var className = classDecl.name.actualText;
                this.emitDeclarationComments(classDecl);
                var classPullDecl = this.compiler.semanticInfoChain.getDeclForAST(classDecl, this.document.fileName);
                this.emitDeclFlags(ToDeclFlags(classDecl.getVarFlags()), classPullDecl, "class");
                this.declFile.Write(className);
                this.pushDeclarationContainer(classDecl);
                this.emitTypeParameters(classDecl.typeParameters);
                this.emitBaseList(classDecl, true);
                this.emitBaseList(classDecl, false);
                this.declFile.WriteLine(" {");

                this.indenter.increaseIndent();
                if (classDecl.constructorDecl) {
                    this.emitClassMembersFromConstructorDefinition(classDecl.constructorDecl);
                }
            }
            else {
                this.indenter.decreaseIndent();
                this.popDeclarationContainer(classDecl);

                this.emitIndent();
                this.declFile.WriteLine("}");
            }

            return true;
        }

        private emitTypeParameters(typeParams: ASTList, funcSignature?: PullSignatureSymbol) {
            if (!typeParams || !typeParams.members.length) {
                return;
            }

            this.declFile.Write("<");
            var containerAst = this.getAstDeclarationContainer();

            var start = new Date().getTime();
            var containerDecl = this.compiler.semanticInfoChain.getDeclForAST(containerAst, this.document.fileName);
            var containerSymbol = <PullTypeSymbol>containerDecl.getSymbol();
            TypeScript.declarationEmitGetTypeParameterSymbolTime += new Date().getTime() - start;

            var typars: PullTypeSymbol[];
            if (funcSignature) {
                typars = funcSignature.getTypeParameters();
            }
            else {
                typars = containerSymbol.getTypeArguments();
                if (!typars || !typars.length) {
                    typars = containerSymbol.getTypeParameters();
                }
            }

            for (var i = 0; i < typars.length; i++) {
                if (i) {
                    this.declFile.Write(", ");
                }

                var memberName = typars[i].getScopedNameEx(containerSymbol, /*useConstraintInName:*/ true);
                this.emitTypeNamesMember(memberName);
            }

            this.declFile.Write(">");
        }

        private interfaceDeclarationCallback(pre: boolean, interfaceDecl: InterfaceDeclaration): boolean {
            if (!this.canEmitPrePostAstSignature(ToDeclFlags(interfaceDecl.getVarFlags()), interfaceDecl, pre)) {
                return false;
            }

            if (interfaceDecl.isObjectTypeLiteral) {
                return false;
            }

            if (pre) {
                var interfaceName = interfaceDecl.name.actualText;
                this.emitDeclarationComments(interfaceDecl);
                var interfacePullDecl = this.compiler.semanticInfoChain.getDeclForAST(interfaceDecl, this.document.fileName);
                this.emitDeclFlags(ToDeclFlags(interfaceDecl.getVarFlags()), interfacePullDecl, "interface");
                this.declFile.Write(interfaceName);
                this.pushDeclarationContainer(interfaceDecl);
                this.emitTypeParameters(interfaceDecl.typeParameters);
                this.emitBaseList(interfaceDecl, true);
                this.declFile.WriteLine(" {");

                this.indenter.increaseIndent();
            }
            else {
                this.indenter.decreaseIndent();
                this.popDeclarationContainer(interfaceDecl);

                this.emitIndent();
                this.declFile.WriteLine("}");
            }

            return true;
        }

        private importDeclarationCallback(pre: boolean, importDeclAST: ImportDeclaration): boolean {
            if (pre) {
                var importDecl = this.compiler.semanticInfoChain.getDeclForAST(importDeclAST, this.document.fileName);
                var importSymbol = <PullTypeAliasSymbol>importDecl.getSymbol();
                var isExportedImportDecl = hasFlag(importDeclAST.getVarFlags(), VariableFlags.Exported);

                if (isExportedImportDecl || importSymbol.typeUsedExternally || PullContainerTypeSymbol.usedAsSymbol(importSymbol.getContainer(), importSymbol)) {
                    this.emitDeclarationComments(importDeclAST);
                    this.emitIndent();
                    if (isExportedImportDecl) {
                        this.declFile.Write("export ");
                    }
                    this.declFile.Write("import ");
                    this.declFile.Write(importDeclAST.id.actualText + " = ");
                    if (importDeclAST.isExternalImportDeclaration()) {
                        this.declFile.WriteLine("require(" + importDeclAST.getAliasName() + ");");
                    }
                    else {
                        this.declFile.WriteLine(importDeclAST.getAliasName() + ";");
                    }
                }
            }

            return false;
        }

        private emitEnumSignature(moduleDecl: ModuleDeclaration) {
            if (!this.canEmitSignature(ToDeclFlags(moduleDecl.getModuleFlags()), moduleDecl)) {
                return false;
            }

            this.emitDeclarationComments(moduleDecl);
            var modulePullDecl = this.compiler.semanticInfoChain.getDeclForAST(moduleDecl, this.document.fileName);
            this.emitDeclFlags(ToDeclFlags(moduleDecl.getModuleFlags()), modulePullDecl, "enum");
            this.declFile.WriteLine(moduleDecl.name.actualText + " {");

            this.indenter.increaseIndent();
            var membersLen = moduleDecl.members.members.length;
            for (var j = 0; j < membersLen; j++) {
                var memberDecl: AST = moduleDecl.members.members[j];
                var variableStatement = <VariableStatement>memberDecl;
                var varDeclarator = <VariableDeclarator>variableStatement.declaration.declarators.members[0];
                this.emitDeclarationComments(varDeclarator);
                this.emitIndent();
                this.declFile.Write(varDeclarator.id.actualText);
                if (varDeclarator.init && varDeclarator.init.nodeType() == NodeType.NumericLiteral) {
                    this.declFile.Write(" = " + (<NumberLiteral>varDeclarator.init).text());
                }
                this.declFile.WriteLine(",");
            }
            this.indenter.decreaseIndent();

            this.emitIndent();
            this.declFile.WriteLine("}");

            return false;
        }

        private moduleDeclarationCallback(pre: boolean, moduleDecl: ModuleDeclaration): boolean {
            if (hasFlag(moduleDecl.getModuleFlags(), ModuleFlags.IsWholeFile)) {
                // This is dynamic modules and we are going to outputing single file, 
                if (hasFlag(moduleDecl.getModuleFlags(), ModuleFlags.IsDynamic)) {
                    if (pre) {
                        // Dynamic Modules always go in their own file
                        this.pushDeclarationContainer(moduleDecl);
                    } else {
                        this.popDeclarationContainer(moduleDecl);
                    }
                }

                return true;
            }

            if (moduleDecl.isEnum()) {
                if (pre) {
                    this.emitEnumSignature(moduleDecl);
                }
                return false;
            }

            if (!this.canEmitPrePostAstSignature(ToDeclFlags(moduleDecl.getModuleFlags()), moduleDecl, pre)) {
                return false;
            }

            if (pre) {
                if (this.emitDottedModuleName()) {
                    this.dottedModuleEmit += ".";
                }
                else {
                    var modulePullDecl = this.compiler.semanticInfoChain.getDeclForAST(moduleDecl, this.document.fileName);
                    this.dottedModuleEmit = this.getDeclFlagsString(ToDeclFlags(moduleDecl.getModuleFlags()), modulePullDecl, "module");
                }

                this.dottedModuleEmit += moduleDecl.name.actualText;

                var isCurrentModuleDotted = (moduleDecl.members.members.length === 1 &&
                    moduleDecl.members.members[0].nodeType() === NodeType.ModuleDeclaration &&
                    !(<ModuleDeclaration>moduleDecl.members.members[0]).isEnum() &&
                    hasFlag((<ModuleDeclaration>moduleDecl.members.members[0]).getModuleFlags(), ModuleFlags.Exported));

                // Module is dotted only if it does not have doc comments for it
                var moduleDeclComments = moduleDecl.docComments();
                isCurrentModuleDotted = isCurrentModuleDotted && (moduleDeclComments === null || moduleDeclComments.length === 0);

                this.isDottedModuleName.push(isCurrentModuleDotted);
                this.pushDeclarationContainer(moduleDecl);

                if (!isCurrentModuleDotted) {
                    this.emitDeclarationComments(moduleDecl);
                    this.declFile.Write(this.dottedModuleEmit);
                    this.declFile.WriteLine(" {");
                    this.indenter.increaseIndent();
                }
            }
            else {
                if (!this.emitDottedModuleName()) {
                    this.indenter.decreaseIndent();
                    this.emitIndent();
                    this.declFile.WriteLine("}");
                }

                this.popDeclarationContainer(moduleDecl);
                this.isDottedModuleName.pop();
            }

            return true;
        }

        public exportAssignmentCallback(pre: boolean, ast: ExportAssignment): boolean {
            if (pre) {
                this.emitIndent();
                this.declFile.Write("export = ");
                this.declFile.Write(ast.id.actualText);
                this.declFile.WriteLine(";");
            }

            return false;
        }

        private emitReferencePaths(script: Script) {
            // In case of shared handler we collect all the references and emit them
            if (this.emittedReferencePaths) {
                return;
            }

            // Collect all the documents that need to be emitted as reference
            var documents: Document[] = [];
            if (this.compiler.emitOptions.outputMany || script.topLevelMod) {
                // Emit only from this file
                var scriptReferences = script.referencedFiles;
                var addedGlobalDocument = false;
                for (var j = 0; j < scriptReferences.length; j++) {
                    var currentReference = scriptReferences[j];
                    var document = this.compiler.getDocument(currentReference);
                    // All the references that are not going to be part of same file

                    if (this.compiler.emitOptions.outputMany || document.script.isDeclareFile || document.script.topLevelMod || !addedGlobalDocument) {
                        documents = documents.concat(document);
                        if (!document.script.isDeclareFile && document.script.topLevelMod) {
                            addedGlobalDocument = true;
                        }
                    }
                }
            } else {
                // Collect from all the references and emit
                var allDocuments = this.compiler.getDocuments();
                for (var i = 0; i < allDocuments.length; i++) {
                    if (!allDocuments[i].script.isDeclareFile && !allDocuments[i].script.topLevelMod) {
                        // Check what references need to be added
                        var scriptReferences = allDocuments[i].script.referencedFiles;
                        for (var j = 0; j < scriptReferences.length; j++) {
                            var currentReference = scriptReferences[j];
                            var document = this.compiler.getDocument(currentReference);

                            if (!document)
                            {
                                process.stdout.write("No doc for ref: " +
                                                     JSON.stringify(currentReference));
                            }

                            // All the references that are not going to be part of same file
                            if (document.script.isDeclareFile || document.script.topLevelMod) {
                                for (var k = 0; k < documents.length; k++) {
                                    if (documents[k] == document) {
                                        break;
                                    }
                                }

                                if (k == documents.length) {
                                    documents = documents.concat(document);
                                }
                            }
                        }
                    }
                }
            }

            // Emit the references
            var emittingFilePath = documents.length ? getRootFilePath(this.emittingFileName) : null;
            for (var i = 0; i < documents.length; i++) {
                var document = documents[i];
                var declFileName: string;
                if (document.script.isDeclareFile) {
                    declFileName = document.fileName;
                } else {
                    declFileName = this.compiler.emitOptions.mapOutputFileName(document, TypeScriptCompiler.mapToDTSFileName);
                }

                // Get the relative path
                declFileName = getRelativePathToFixedPath(emittingFilePath, declFileName, false);
                this.declFile.WriteLine('/// <reference path="' + declFileName + '" />');
            }

            this.emittedReferencePaths = true;
        }

        public scriptCallback(pre: boolean, script: Script): boolean {
            if (pre) {
                this.emitReferencePaths(script);
                this.pushDeclarationContainer(script);
            }
            else {
                this.popDeclarationContainer(script);
            }
            return true;
        }

        private defaultCallback(pre: boolean, ast: AST): boolean {
            return !ast.isStatement();
        }
    }
}
