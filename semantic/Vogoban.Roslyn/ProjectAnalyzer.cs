using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;

namespace Vogoban.Roslyn;

public sealed class ProjectAnalyzer
{
    private const int MaxLocationsPerRelation = 10;
    private const int MaxDiagnostics = 25;

    private readonly CSharpCompilation _compilation;
    private readonly string _root;
    private readonly ProjectResult _result;
    private readonly Dictionary<string, RelationFact> _relations = new();
    private readonly HashSet<string> _declared = new();
    private readonly HashSet<string> _unresolvedSeen = new();
    private readonly Dictionary<string, List<(Location Span, string Id, string Message)>> _errorsByFile = new();
    private readonly Dictionary<SyntaxTree, List<(int Start, int End, string Condition)>> _conditionalRegions = new();

    public const string FrameworkAssembly = "@framework";
    private readonly HashSet<string> _frameworkAssemblies;

    public ProjectAnalyzer(CSharpCompilation compilation, string root, ProjectResult result, HashSet<string> frameworkAssemblies)
    {
        _frameworkAssemblies = frameworkAssemblies;
        _compilation = compilation;
        _root = root;
        _result = result;
    }

    public void Run()
    {
        CollectDiagnostics();
        foreach (var type in SourceTypes(_compilation.Assembly.GlobalNamespace)) DeclareType(type);
        foreach (var tree in _compilation.SyntaxTrees)
        {
            if (string.IsNullOrEmpty(tree.FilePath)) continue;
            WalkBodies(tree, _compilation.GetSemanticModel(tree));
        }
        _result.Relations.AddRange(_relations.Values.OrderBy(r => r.Type, StringComparer.Ordinal).ThenBy(r => r.Source, StringComparer.Ordinal).ThenBy(r => r.Target.Key, StringComparer.Ordinal));

    }

    private void CollectDiagnostics()
    {
        foreach (var d in _compilation.GetDiagnostics().Where(d => d.Severity >= DiagnosticSeverity.Warning).OrderBy(d => d.Location.SourceTree?.FilePath, StringComparer.Ordinal).ThenBy(d => d.Location.SourceSpan.Start).ThenBy(d => d.Location.SourceSpan.End).ThenBy(d => d.Id, StringComparer.Ordinal).ThenBy(d => d.GetMessage(), StringComparer.Ordinal))
        {
            if (d.Severity == DiagnosticSeverity.Error) _result.CompilerErrors++;
            else _result.CompilerWarnings++;
            if (d.Severity != DiagnosticSeverity.Error) continue;
            var span = d.Location.GetLineSpan();
            if (d.Location.IsInSource)
            {
                var location = ToLocation(d.Location);
                if (!_errorsByFile.TryGetValue(location.File, out var list)) _errorsByFile[location.File] = list = new();
                list.Add((location, d.Id, d.GetMessage()));
            }
            if (_result.Diagnostics.Count >= MaxDiagnostics) continue;
            _result.Diagnostics.Add(new CompilerDiagnostic
            {
                Id = d.Id,
                Severity = d.Severity.ToString(),
                Message = d.GetMessage(),
                File = d.Location.IsInSource ? Rel(span.Path) : null,
                Line = span.StartLinePosition.Line + 1,
            });
        }
    }

    private string? DiagnosticAt(Location location, string display)
    {
        if (!_errorsByFile.TryGetValue(location.File, out var errors)) return null;
        static int Pos(int line, int col) => line * 100000 + col;
        var start = Pos(location.Line, location.Column);
        var end = Pos(location.EndLine == 0 ? location.Line : location.EndLine, location.EndColumn == 0 ? int.MaxValue / 200000 : location.EndColumn);
        var overlapping = errors.Where(e => Pos(e.Span.Line, e.Span.Column) <= end && Pos(e.Span.EndLine, e.Span.EndColumn) >= start).ToList();
        var name = display.Split('<', '(')[0].Split('.').Last();
        bool Names((Location Span, string Id, string Message) e) => name.Length > 0 && e.Message.Contains($"'{name}");
        return overlapping.FirstOrDefault(Names).Id
            ?? overlapping.FirstOrDefault().Id
            ?? errors.FirstOrDefault(e => e.Span.Line == location.Line && Names(e)).Id;
    }

    private List<string>? Conditions(ISymbol symbol)
    {
        var loc = symbol.Locations.FirstOrDefault(l => l.IsInSource);
        if (loc?.SourceTree == null) return null;
        if (!_conditionalRegions.TryGetValue(loc.SourceTree, out var regions))
            _conditionalRegions[loc.SourceTree] = regions = ConditionalRegions(loc.SourceTree);
        var position = loc.SourceSpan.Start;
        var conditions = regions.Where(r => r.Start <= position && position < r.End).Select(r => r.Condition).ToList();
        return conditions.Count == 0 ? null : conditions;
    }

    private static List<(int Start, int End, string Condition)> ConditionalRegions(SyntaxTree tree)
    {
        var regions = new List<(int, int, string)>();
        var stack = new Stack<(List<string> Prior, int Start, string Condition, bool Taken)>();
        foreach (var directive in tree.GetRoot().DescendantTrivia().Where(t => t.IsDirective).Select(t => t.GetStructure()).OfType<DirectiveTriviaSyntax>())
        {
            switch (directive)
            {
                case IfDirectiveTriviaSyntax ifd when directive.IsKind(SyntaxKind.IfDirectiveTrivia):
                    stack.Push((new List<string> { ifd.Condition.ToString() }, directive.Span.End, ifd.Condition.ToString(), ifd.BranchTaken));
                    break;
                case ElifDirectiveTriviaSyntax elif when stack.Count > 0:
                {
                    var top = stack.Pop();
                    if (top.Taken) regions.Add((top.Start, directive.SpanStart, $"#if {top.Condition}"));
                    var condition = $"{elif.Condition} && !({string.Join(" || ", top.Prior)})";
                    top.Prior.Add(elif.Condition.ToString());
                    stack.Push((top.Prior, directive.Span.End, condition, elif.BranchTaken));
                    break;
                }
                case ElseDirectiveTriviaSyntax els when stack.Count > 0:
                {
                    var top = stack.Pop();
                    if (top.Taken) regions.Add((top.Start, directive.SpanStart, $"#if {top.Condition}"));
                    stack.Push((top.Prior, directive.Span.End, $"!({string.Join(" || ", top.Prior)})", els.BranchTaken));
                    break;
                }
                case EndIfDirectiveTriviaSyntax when stack.Count > 0:
                {
                    var top = stack.Pop();
                    if (top.Taken) regions.Add((top.Start, directive.SpanStart, $"#if {top.Condition}"));
                    break;
                }
            }
        }
        return regions;
    }

    private static IEnumerable<INamedTypeSymbol> SourceTypes(INamespaceSymbol ns)
    {
        foreach (var member in ns.GetMembers().OrderBy(m => m.Name, StringComparer.Ordinal))
        {
            if (member is INamespaceSymbol child)
                foreach (var t in SourceTypes(child)) yield return t;
            else if (member is INamedTypeSymbol type)
                foreach (var t in WithNested(type)) yield return t;
        }
    }

    private static IEnumerable<INamedTypeSymbol> WithNested(INamedTypeSymbol type)
    {
        if (!type.Locations.Any(l => l.IsInSource)) yield break;
        yield return type;
        foreach (var nested in type.GetTypeMembers().OrderBy(t => t.Name, StringComparer.Ordinal))
            foreach (var t in WithNested(nested)) yield return t;
    }

    private static bool IsEntryPoint(ISymbol s) => s is IMethodSymbol { Name: WellKnownMemberNames.TopLevelStatementsEntryPointMethodName };

    private static bool IsDeclarable(ISymbol member) => member switch
    {
        IMethodSymbol m => (!m.IsImplicitlyDeclared || IsEntryPoint(m))
            && m.MethodKind is MethodKind.Ordinary or MethodKind.Constructor or MethodKind.StaticConstructor or MethodKind.UserDefinedOperator or MethodKind.Conversion or MethodKind.Destructor or MethodKind.ExplicitInterfaceImplementation,
        IPropertySymbol p => !p.IsImplicitlyDeclared,
        IFieldSymbol f => !f.IsImplicitlyDeclared,
        IEventSymbol e => !e.IsImplicitlyDeclared,
        _ => false,
    };

    private void DeclareType(INamedTypeSymbol type)
    {
        var key = Key(type);
        _declared.Add(key);
        _result.Symbols.Add(new SymbolFact
        {
            Key = key,
            Kind = TypeKindName(type),
            Name = type.Name,
            QualifiedName = Qualified(type),
            Signature = type.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat),
            ContainerKey = type.ContainingType != null ? Key(type.ContainingType) : null,
            Namespace = Namespace(type),
            Location = SourceLocation(type),
            AdditionalLocations = type.Locations.Where(l => l.IsInSource).Skip(1).Select(ToLocation).ToList(),
            Accessibility = type.DeclaredAccessibility.ToString(),
            Modifiers = Modifiers(type),
            Attributes = type.GetAttributes().Select(ToAttribute).OfType<AttributeFact>().ToList(),
            BaseTypeChain = BaseChain(type),
            AllInterfaces = type.AllInterfaces.Select(i => Qualified(i.OriginalDefinition)).Distinct().OrderBy(s => s, StringComparer.Ordinal).ToList(),
            Arity = type.Arity,
            Generated = IsGenerated(type),
            Implicit = type.IsImplicitlyDeclared,
            Conditions = Conditions(type),
            Parameters = type.DelegateInvokeMethod?.Parameters.Select(ToParameter).ToList() ?? new(),
            ReturnType = type.DelegateInvokeMethod != null ? Ref(type.DelegateInvokeMethod.ReturnType) : null,
        });

        var declLocation = SourceLocation(type);
        if (type.BaseType is { } baseType && baseType.SpecialType is not (SpecialType.System_Object or SpecialType.System_ValueType or SpecialType.System_Enum or SpecialType.System_MulticastDelegate))
        {
            if (baseType.TypeKind == TypeKind.Error) Unresolved("INHERITS", key, baseType.ToDisplayString(), "base type could not be resolved", declLocation);
            else Relate("INHERITS", key, Ref(baseType), declLocation);
        }
        foreach (var iface in type.Interfaces)
        {
            var relType = type.TypeKind == TypeKind.Interface ? "EXTENDS" : "IMPLEMENTS";
            if (iface.TypeKind == TypeKind.Error) Unresolved(relType, key, iface.ToDisplayString(), "interface could not be resolved", declLocation);
            else Relate(relType, key, Ref(iface), declLocation);
        }

        var implementations = new Dictionary<ISymbol, List<ISymbol>>(SymbolEqualityComparer.Default);
        if (type.TypeKind != TypeKind.Interface)
        {
            foreach (var iface in type.AllInterfaces)
            foreach (var ifaceMember in iface.GetMembers())
            {
                if (type.FindImplementationForInterfaceMember(ifaceMember) is not { } impl) continue;
                if (!implementations.TryGetValue(impl, out var list)) implementations[impl] = list = new();
                list.Add(ifaceMember);
            }
        }

        foreach (var member in type.GetMembers().Where(IsDeclarable).OrderBy(m => m.Name, StringComparer.Ordinal))
        {
            var memberKey = Key(member);
            if (!_declared.Add(memberKey)) continue;
            var location = SourceLocation(member) ?? declLocation;
            var fact = MemberFact(member, memberKey, key);
            _result.Symbols.Add(fact);

            if (implementations.TryGetValue(member, out var implemented))
                foreach (var target in implemented) Relate("IMPLEMENTS", memberKey, Ref(target), location);

            switch (member)
            {
                case IMethodSymbol method:
                    if (method.OverriddenMethod != null) Relate("OVERRIDES", memberKey, Ref(method.OverriddenMethod), location);
                    if (method.MethodKind != MethodKind.Constructor && method.MethodKind != MethodKind.StaticConstructor && !method.ReturnsVoid)
                        RelateType("RETURNS_TYPE", memberKey, method.ReturnType, location);
                    break;
                case IPropertySymbol property:
                    if (property.OverriddenProperty != null) Relate("OVERRIDES", memberKey, Ref(property.OverriddenProperty), location);
                    RelateType("USES_TYPE", memberKey, property.Type, location);
                    break;
                case IFieldSymbol field:
                    RelateType("USES_TYPE", memberKey, field.Type, location);
                    break;
                case IEventSymbol evt:
                    RelateType("USES_TYPE", memberKey, evt.Type, location);
                    break;
            }
        }
    }

    private SymbolFact MemberFact(ISymbol member, string key, string containerKey)
    {
        var method = member as IMethodSymbol;
        var property = member as IPropertySymbol;
        ITypeSymbol? returnType = method != null ? (method.ReturnsVoid ? null : method.ReturnType)
            : property?.Type ?? (member as IFieldSymbol)?.Type ?? (member as IEventSymbol)?.Type;
        var parameters = method?.Parameters ?? property?.Parameters ?? System.Collections.Immutable.ImmutableArray<IParameterSymbol>.Empty;
        return new SymbolFact
        {
            Key = key,
            Kind = MemberKindName(member),
            Name = member.Name,
            QualifiedName = Qualified(member),
            Signature = member.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat),
            ContainerKey = containerKey,
            Namespace = Namespace(member),
            Location = SourceLocation(member),
            AdditionalLocations = member.Locations.Where(l => l.IsInSource).Skip(1)
                .Concat(method?.PartialImplementationPart?.Locations.Where(l => l.IsInSource) ?? Enumerable.Empty<Microsoft.CodeAnalysis.Location>())
                .Select(ToLocation).ToList(),
            Conditions = Conditions(member),
            Accessibility = member.DeclaredAccessibility.ToString(),
            Modifiers = Modifiers(member),
            ReturnType = returnType == null || method?.MethodKind == MethodKind.Constructor ? null : Ref(returnType),
            ReturnTypeDisplay = returnType?.ToDisplayString(),
            Parameters = parameters.Select(ToParameter).ToList(),
            Attributes = member.GetAttributes().Select(ToAttribute).OfType<AttributeFact>().ToList(),
            ReturnAttributes = method?.GetReturnTypeAttributes() is { Length: > 0 } returnAttributes ? returnAttributes.Select(ToAttribute).OfType<AttributeFact>().ToList() : null,
            Arity = method?.Arity ?? 0,
            Generated = IsGenerated(member),
            Implicit = member.IsImplicitlyDeclared,
        };
    }

    private ParameterFact ToParameter(IParameterSymbol p) => new()
    {
        Name = p.Name,
        Ordinal = p.Ordinal,
        Type = Ref(p.Type),
        TypeDisplay = p.Type.ToDisplayString(),
        RefKind = p.RefKind == RefKind.None ? null : p.RefKind.ToString(),
        IsParams = p.IsParams,
        HasDefault = p.HasExplicitDefaultValue,
        Attributes = p.GetAttributes().Select(ToAttribute).OfType<AttributeFact>().ToList(),
    };

    private void WalkBodies(SyntaxTree tree, SemanticModel model)
    {
        var root = tree.GetRoot();
        foreach (var node in root.DescendantNodes())
        {
            switch (node)
            {
                case InvocationExpressionSyntax invocation:
                    HandleInvocation(invocation, model);
                    break;
                case BaseObjectCreationExpressionSyntax creation:
                    HandleCreation(creation, model);
                    break;
                case SimpleNameSyntax name:
                    HandleName(name, model);
                    break;
                case ElementAccessExpressionSyntax access:
                    HandleElementAccess(access, model);
                    break;
                case AssignmentExpressionSyntax { RawKind: (int)SyntaxKind.SimpleAssignmentExpression } assignment:
                    HandlePropertyAssignment(assignment, model);
                    HandleMemberAssignment(assignment, model);
                    break;
                case VariableDeclaratorSyntax { Parent.Parent: FieldDeclarationSyntax, Initializer.Value: { } fieldInit } fieldDeclarator:
                    HandleMemberInitializer(fieldDeclarator, fieldInit, model);
                    break;
                case PropertyDeclarationSyntax { Initializer.Value: { } propertyInit } propertyDeclaration:
                    HandleMemberInitializer(propertyDeclaration, propertyInit, model);
                    break;
                case VariableDeclarationSyntax { Type.IsVar: true } declaration:
                    HandleInferredLocal(declaration, model);
                    break;
                case ConstructorInitializerSyntax initializer:
                    HandleConstructorCall(initializer, initializer.ThisOrBaseKeyword.Text, model);
                    break;
                case PrimaryConstructorBaseTypeSyntax primaryBase:
                    HandleConstructorCall(primaryBase, primaryBase.Type.ToString(), model);
                    break;
            }
        }
    }

    private string? CallerKey(SyntaxNode node, SemanticModel model)
    {
        var symbol = model.GetEnclosingSymbol(node.SpanStart);
        while (symbol != null)
        {
            if (symbol is IMethodSymbol { MethodKind: MethodKind.PropertyGet or MethodKind.PropertySet or MethodKind.EventAdd or MethodKind.EventRemove } accessor && accessor.AssociatedSymbol != null)
                symbol = accessor.AssociatedSymbol;
            if (symbol is IMethodSymbol { MethodKind: MethodKind.AnonymousFunction or MethodKind.LocalFunction })
            {
                symbol = symbol.ContainingSymbol;
                continue;
            }
            var key = Key(symbol);
            if (_declared.Contains(key)) return key;
            if (symbol is INamespaceSymbol) return null;
            symbol = symbol.ContainingSymbol;
        }
        return null;
    }

    private void HandleInvocation(InvocationExpressionSyntax invocation, SemanticModel model)
    {
        if (invocation.Expression is IdentifierNameSyntax { Identifier.Text: "nameof" }) return;
        var caller = CallerKey(invocation, model);
        if (caller == null) return;
        var info = model.GetSymbolInfo(invocation);
        var location = ToLocation(invocation.GetLocation());
        if (info.Symbol is not IMethodSymbol method)
        {
            if (model.GetTypeInfo(invocation.Expression).Type is { TypeKind: TypeKind.Dynamic }) return;
            var receiverExpression = invocation.Expression switch
            {
                MemberAccessExpressionSyntax access => access.Expression,
                MemberBindingExpressionSyntax => invocation.FirstAncestorOrSelf<ConditionalAccessExpressionSyntax>()?.Expression,
                _ => null,
            };
            if (receiverExpression != null && model.GetTypeInfo(receiverExpression).Type is { TypeKind: TypeKind.Error } errorReceiver)
            {
                Unresolved("CALLS", caller, Truncate(invocation.Expression.ToString()), $"receiver type '{errorReceiver.ToDisplayString()}' could not be resolved", location, cascadedFrom: errorReceiver.ToDisplayString());
                return;
            }
            Unresolved("CALLS", caller, Truncate(invocation.Expression.ToString()), info.CandidateReason == CandidateReason.None ? "no symbol bound for invocation target" : $"overload resolution: {info.CandidateReason}", location, info.CandidateSymbols);
            return;
        }
        var target = method.ReducedFrom ?? method;
        if (target.MethodKind == MethodKind.LocalFunction || target.MethodKind == MethodKind.AnonymousFunction) return;
        var targetRef = Ref(target);
        Relate("CALLS", caller, targetRef, location);
        if (!targetRef.External && target.ContainingType?.TypeKind != TypeKind.Interface && !target.IsGenericMethod && !target.IsExtensionMethod) return;

        var (controlFlow, condition) = ControlFlow(invocation);
        _result.Invocations.Add(new InvocationFact
        {
            Caller = caller,
            Target = targetRef,
            TypeArguments = method.TypeArguments.Select(t => Ref(t)).OfType<SymRef>().ToList(),
            Arguments = Arguments(invocation.ArgumentList, model, model.GetOperation(invocation), 0),
            Receiver = Receiver(invocation.Expression is MemberAccessExpressionSyntax ma ? ma.Expression : null, model, 0),
            ReceiverType = target.IsExtensionMethod && target.Parameters.Length > 0 ? Ref(target.Parameters[0].Type) : target.ContainingType == null ? null : Ref(target.ContainingType),
            ControlFlow = controlFlow,
            Condition = condition,
            Location = location,
        });
    }

    private (string? Kind, string? Condition) ControlFlow(SyntaxNode node)
    {
        string? kind = null;
        string? condition = null;
        for (var current = node; current.Parent != null; current = current.Parent)
        {
            var parent = current.Parent;
            if (parent is MemberDeclarationSyntax or GlobalStatementSyntax or LocalFunctionStatementSyntax or CompilationUnitSyntax) break;
            switch (parent)
            {
                case IfStatementSyntax ifs when ifs.Condition != current:
                    kind ??= "conditional";
                    condition ??= ifs.Statement == current ? Truncate(ifs.Condition.ToString()) : $"!({Truncate(ifs.Condition.ToString())})";
                    break;
                case ElseClauseSyntax:
                case SwitchSectionSyntax:
                case SwitchExpressionArmSyntax:
                case CatchClauseSyntax:
                case BinaryExpressionSyntax { RawKind: (int)SyntaxKind.CoalesceExpression or (int)SyntaxKind.LogicalAndExpression or (int)SyntaxKind.LogicalOrExpression } binary when binary.Right == current:
                    kind ??= "conditional";
                    break;
                case ConditionalExpressionSyntax ce when ce.Condition != current:
                    kind ??= "conditional";
                    condition ??= Truncate(ce.Condition.ToString());
                    break;
                case ConditionalAccessExpressionSyntax ca when ca.WhenNotNull.Span.Contains(current.Span):
                    kind ??= "conditional";
                    break;
                case ForStatementSyntax or ForEachStatementSyntax or WhileStatementSyntax or DoStatementSyntax:
                    kind = kind == null ? "loop" : kind;
                    break;
            }
        }
        var tree = node.SyntaxTree;
        if (!_conditionalRegions.TryGetValue(tree, out var regions)) _conditionalRegions[tree] = regions = ConditionalRegions(tree);
        var region = regions.FirstOrDefault(r => r.Start <= node.SpanStart && node.SpanStart < r.End);
        if (region.Condition != null)
        {
            kind ??= "conditional";
            condition ??= region.Condition;
        }
        return (kind, condition);
    }

    private List<ArgValue> Arguments(BaseArgumentListSyntax? list, SemanticModel model, IOperation? operation, int depth)
    {
        if (list == null) return new();
        var parameters = new Dictionary<SyntaxNode, string>();
        var arguments = operation switch
        {
            IInvocationOperation inv => inv.Arguments,
            IObjectCreationOperation oc => oc.Arguments,
            IPropertyReferenceOperation pr => pr.Arguments,
            _ => System.Collections.Immutable.ImmutableArray<IArgumentOperation>.Empty,
        };
        foreach (var a in arguments)
            if (a.Parameter != null && a.Syntax is ArgumentSyntax) parameters[a.Syntax] = a.Parameter.Name;
        return list.Arguments.Select(a =>
        {
            var value = Argument(a.Expression, model, a.NameColon?.Name.Identifier.Text, depth);
            value.Parameter = parameters.TryGetValue(a, out var p) ? p : null;
            return value;
        }).ToList();
    }

    private ReceiverFact? Receiver(ExpressionSyntax? expression, SemanticModel model, int depth)
    {
        if (expression == null || depth > 6) return null;
        var type = model.GetTypeInfo(expression).Type;
        var inner = expression;
        var bound = model.GetSymbolInfo(expression).Symbol;
        var symbol = bound is IFieldSymbol or IPropertySymbol or IParameterSymbol or ILocalSymbol && IsCloudSdkType(type) ? Ref(bound) : null;
        if (expression is IdentifierNameSyntax id && model.GetSymbolInfo(id).Symbol is ILocalSymbol local)
        {
            var declarator = local.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax() as VariableDeclaratorSyntax;
            if (declarator?.Initializer?.Value is { } init) inner = init;
        }
        var awaited = inner;
        while (awaited is AwaitExpressionSyntax or ParenthesizedExpressionSyntax)
            awaited = awaited is AwaitExpressionSyntax aw ? aw.Expression : ((ParenthesizedExpressionSyntax)awaited).Expression;
        if (awaited != inner && awaited is InvocationExpressionSyntax awaitedCall && model.GetSymbolInfo(awaitedCall).Symbol is IMethodSymbol awaitedMethod && IsCloudSdkType(awaitedMethod.ContainingType)) inner = awaited;
        if (inner is InvocationExpressionSyntax call && model.GetSymbolInfo(call).Symbol is IMethodSymbol m)
        {
            var target = m.ReducedFrom ?? m;
            return new ReceiverFact
            {
                Expression = Truncate(expression.ToString()),
                Type = type == null ? null : Ref(type),
                InvocationTarget = Ref(target),
                InvocationTypeArguments = m.TypeArguments.Select(t => Ref(t)).ToList(),
                InvocationArguments = Arguments(call.ArgumentList, model, model.GetOperation(call), 1),
                Location = ToLocation(call.GetLocation()),
                Receiver = Receiver(call.Expression is MemberAccessExpressionSyntax ma ? ma.Expression : null, model, depth + 1),
                Symbol = symbol,
            };
        }
        if (inner is BaseObjectCreationExpressionSyntax creation && model.GetSymbolInfo(creation).Symbol is IMethodSymbol ctor && IsCloudSdkType(ctor.ContainingType))
        {
            return new ReceiverFact
            {
                Expression = Truncate(expression.ToString()),
                Type = type == null ? null : Ref(type),
                InvocationTarget = Ref(ctor),
                InvocationArguments = Arguments(creation.ArgumentList, model, model.GetOperation(creation), 1),
                Location = ToLocation(creation.GetLocation()),
                Symbol = symbol,
            };
        }
        return new ReceiverFact { Expression = Truncate(expression.ToString()), Type = type == null ? null : Ref(type), Symbol = symbol };
    }

    private ArgValue Argument(ExpressionSyntax expression, SemanticModel model, string? name, int depth)
    {
        while (expression is ParenthesizedExpressionSyntax or PostfixUnaryExpressionSyntax { RawKind: (int)SyntaxKind.SuppressNullableWarningExpression })
            expression = expression is ParenthesizedExpressionSyntax p ? p.Expression : ((PostfixUnaryExpressionSyntax)expression).Operand;
        var constant = model.GetConstantValue(expression);
        if (constant.HasValue)
            return new ArgValue { Name = name, Kind = constant.Value switch { null => "null", string => "string", bool => "bool", _ => "number" }, Value = Redaction.Value(constant.Value?.ToString()) };
        switch (expression)
        {
            case TypeOfExpressionSyntax typeOf:
                return new ArgValue { Name = name, Kind = "type", Type = Ref(model.GetTypeInfo(typeOf.Type).Type) };
            case LambdaExpressionSyntax or AnonymousMethodExpressionSyntax:
            {
                var callable = Callable(model.GetSymbolInfo(expression).Symbol as IMethodSymbol, name, expression.GetLocation(), null);
                callable.ReturnedType = ReturnedType((AnonymousFunctionExpressionSyntax)expression, model);
                return callable;
            }
            case BaseObjectCreationExpressionSyntax creation when depth < 2:
            {
                var ctor = model.GetSymbolInfo(creation).Symbol as IMethodSymbol;
                var created = model.GetTypeInfo(creation).Type;
                return new ArgValue
                {
                    Name = name,
                    Kind = "new",
                    Symbol = ctor == null ? null : Ref(ctor),
                    Type = created == null ? null : Ref(created),
                    Items = Arguments(creation.ArgumentList, model, model.GetOperation(creation), depth + 1),
                };
            }
            case InvocationExpressionSyntax nested when depth < 2 && model.GetSymbolInfo(nested).Symbol is IMethodSymbol nestedMethod:
            {
                var resultType = model.GetTypeInfo(nested).Type;
                return new ArgValue
                {
                    Name = name,
                    Kind = "invocation",
                    Symbol = Ref(nestedMethod.ReducedFrom ?? nestedMethod),
                    Type = resultType == null ? null : Ref(resultType),
                    TypeArguments = nestedMethod.TypeArguments.Select(t => Ref(t)).ToList(),
                    Items = Arguments(nested.ArgumentList, model, model.GetOperation(nested), depth + 1),
                };
            }
        }
        if (expression is ElementAccessExpressionSyntax access && depth < 2 && model.GetSymbolInfo(access).Symbol is IPropertySymbol { IsIndexer: true } indexer)
        {
            return new ArgValue
            {
                Name = name,
                Kind = "indexer",
                Symbol = Ref(indexer),
                Type = Ref(indexer.Type),
                Items = Arguments(access.ArgumentList, model, model.GetOperation(access), depth + 1),
            };
        }
        if (depth < 3 && expression is IdentifierNameSyntax localName && model.GetSymbolInfo(localName).Symbol is ILocalSymbol localSymbol && SingleInitializer(localSymbol, localName) is { } initializer)
        {
            var resolved = Argument(initializer, model, name, depth + 1);
            if (resolved.Kind != "expression") return resolved;
        }
        var template = Template(expression, model, 0);
        if (template != null && System.Text.RegularExpressions.Regex.Replace(template, @"\{[^}]*\}", "").Length > 0)
            return new ArgValue { Name = name, Kind = "template", Value = Redaction.Url(template), Type = model.GetTypeInfo(expression).Type is { } templateType ? Ref(templateType) : null };
        var info = model.GetSymbolInfo(expression);
        var symbol = info.Symbol ?? (info.CandidateSymbols.Length == 1 && info.CandidateSymbols[0] is IMethodSymbol ? info.CandidateSymbols[0] : null);
        if (symbol is IMethodSymbol { MethodKind: MethodKind.LocalFunction } local && expression is SimpleNameSyntax)
            return Callable(local, name, local.Locations.FirstOrDefault(l => l.IsInSource) ?? expression.GetLocation(), $"local-function:{local.Name}");
        if (symbol is IMethodSymbol { MethodKind: MethodKind.Ordinary or MethodKind.ReducedExtension } group && expression is SimpleNameSyntax or MemberAccessExpressionSyntax)
            return new ArgValue { Name = name, Kind = "method", Symbol = Ref(group.ReducedFrom ?? group) };
        var type = model.GetTypeInfo(expression).Type;
        return new ArgValue { Name = name, Kind = "expression", Value = Truncate(expression.ToString()), Type = type == null ? null : Ref(type) };
    }

    private SymRef? ReturnedType(AnonymousFunctionExpressionSyntax lambda, SemanticModel model)
    {
        IEnumerable<ExpressionSyntax> returned = lambda.ExpressionBody != null
            ? new[] { lambda.ExpressionBody }
            : lambda.Block?.DescendantNodes(n => n is not AnonymousFunctionExpressionSyntax and not LocalFunctionStatementSyntax).OfType<ReturnStatementSyntax>().Select(r => r.Expression).OfType<ExpressionSyntax>() ?? Enumerable.Empty<ExpressionSyntax>();
        var types = returned.Select(e => model.GetTypeInfo(e).Type).ToList();
        if (types.Count == 0 || types.Any(t => t == null || t.TypeKind == TypeKind.Error)) return null;
        var distinct = types.Distinct(SymbolEqualityComparer.Default).ToList();
        return distinct.Count == 1 ? Ref((ITypeSymbol)distinct[0]!) : null;
    }

    private static ExpressionSyntax? SingleInitializer(ILocalSymbol local, SyntaxNode usage)
    {
        if (local.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax() is not VariableDeclaratorSyntax { Initializer.Value: var value } declarator) return null;
        var body = declarator.FirstAncestorOrSelf<BlockSyntax>() ?? (SyntaxNode?)declarator.FirstAncestorOrSelf<CompilationUnitSyntax>();
        if (body == null) return null;
        var reassigned = body.DescendantNodes().OfType<AssignmentExpressionSyntax>().Any(a => a.Left is IdentifierNameSyntax id && id.Identifier.Text == local.Name);
        return reassigned ? null : value;
    }

    private string? Template(ExpressionSyntax expression, SemanticModel model, int depth)
    {
        if (depth > 4) return null;
        while (expression is ParenthesizedExpressionSyntax or PostfixUnaryExpressionSyntax { RawKind: (int)SyntaxKind.SuppressNullableWarningExpression })
            expression = expression is ParenthesizedExpressionSyntax p ? p.Expression : ((PostfixUnaryExpressionSyntax)expression).Operand;
        var constant = model.GetConstantValue(expression);
        if (constant.HasValue) return constant.Value?.ToString();
        string Hole(ExpressionSyntax hole) => Template(hole, model, depth + 1) ?? $"{{{HoleName(hole)}}}";
        switch (expression)
        {
            case InterpolatedStringExpressionSyntax interpolated:
                return string.Concat(interpolated.Contents.Select(c => c switch
                {
                    InterpolatedStringTextSyntax text => text.TextToken.ValueText,
                    InterpolationSyntax hole => Hole(hole.Expression),
                    _ => "",
                }));
            case BinaryExpressionSyntax { RawKind: (int)SyntaxKind.AddExpression } add when model.GetTypeInfo(add).Type?.SpecialType == SpecialType.System_String:
                return Hole(add.Left) + Hole(add.Right);
            case IdentifierNameSyntax or MemberAccessExpressionSyntax:
            {
                var symbol = model.GetSymbolInfo(expression).Symbol;
                if (symbol is IFieldSymbol { IsReadOnly: true } field && field.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax() is VariableDeclaratorSyntax { Initializer.Value: var fieldInit } && model.Compilation.GetSemanticModel(fieldInit.SyntaxTree).GetConstantValue(fieldInit) is { HasValue: true } fieldConst)
                    return fieldConst.Value?.ToString();
                if (symbol is ILocalSymbol local && SingleInitializer(local, expression) is { } init)
                    return Template(init, model, depth + 1);
                return null;
            }
        }
        return null;
    }

    private static string HoleName(ExpressionSyntax hole)
    {
        var text = hole switch
        {
            IdentifierNameSyntax id => id.Identifier.Text,
            MemberAccessExpressionSyntax ma => ma.Name.Identifier.Text,
            _ => "expr",
        };
        return text.Length > 40 ? "expr" : text;
    }

    private ArgValue Callable(IMethodSymbol? callable, string? name, Microsoft.CodeAnalysis.Location location, string? value) => new()
    {
        Name = name,
        Kind = "lambda",
        Value = value,
        Location = ToLocation(location),
        Attributes = callable?.GetAttributes().Select(ToAttribute).OfType<AttributeFact>().ToList(),
        Type = callable != null && !callable.ReturnsVoid ? Ref(callable.ReturnType) : null,
        Items = callable?.Parameters.Select(p => new ArgValue
        {
            Name = p.Name,
            Kind = "parameter",
            Type = Ref(p.Type),
            Items = p.GetAttributes().Select(a => new ArgValue
            {
                Kind = "attribute",
                Type = a.AttributeClass == null ? null : Ref(a.AttributeClass),
                Items = a.ConstructorArguments.Select(c => Constant(c, null)).Concat(a.NamedArguments.Select(n => Constant(n.Value, n.Key))).ToList(),
            }).ToList(),
        }).ToList(),
    };

    private void HandlePropertyAssignment(AssignmentExpressionSyntax assignment, SemanticModel model)
    {
        if (model.GetSymbolInfo(assignment.Left).Symbol is not IPropertySymbol { IsIndexer: false } property || property.Locations.Any(l => l.IsInSource)) return;
        var caller = CallerKey(assignment, model);
        if (caller == null) return;
        var (controlFlow, condition) = ControlFlow(assignment);
        var value = Argument(assignment.Right, model, null, 0);
        value.Parameter = "value";
        _result.Invocations.Add(new InvocationFact
        {
            Caller = caller,
            Target = Ref(property),
            Arguments = new List<ArgValue> { value },
            Receiver = Receiver(assignment.Left is MemberAccessExpressionSyntax ma ? ma.Expression : null, model, 0),
            ReceiverType = Ref(property.ContainingType),
            ControlFlow = controlFlow,
            Condition = condition,
            Location = ToLocation(assignment.GetLocation()),
        });
    }

    private void HandleElementAccess(ElementAccessExpressionSyntax access, SemanticModel model)
    {
        if (model.GetSymbolInfo(access).Symbol is not IPropertySymbol { IsIndexer: true } indexer || indexer.Locations.Any(l => l.IsInSource)) return;
        var caller = CallerKey(access, model);
        if (caller == null) return;
        var location = ToLocation(access.GetLocation());
        var (controlFlow, condition) = ControlFlow(access);
        _result.Invocations.Add(new InvocationFact
        {
            Caller = caller,
            Target = Ref(indexer),
            Arguments = Arguments(access.ArgumentList, model, model.GetOperation(access), 0),
            Receiver = Receiver(access.Expression, model, 0),
            ReceiverType = Ref(indexer.ContainingType),
            ControlFlow = controlFlow,
            Condition = condition,
            Location = location,
        });
    }

    private void HandleInferredLocal(VariableDeclarationSyntax declaration, SemanticModel model)
    {
        if (model.GetTypeInfo(declaration.Type).Type is not { } type || type.IsAnonymousType) return;
        var caller = CallerKey(declaration, model);
        if (caller != null) RelateType("USES_TYPE", caller, type, ToLocation(declaration.Type.GetLocation()));
    }

    private void HandleConstructorCall(SyntaxNode node, string display, SemanticModel model)
    {
        var caller = CallerKey(node, model);
        if (caller == null) return;
        var location = ToLocation(node.GetLocation());
        var info = model.GetSymbolInfo(node);
        if (info.Symbol is IMethodSymbol ctor)
        {
            if (!ctor.IsImplicitlyDeclared) Relate("CALLS", caller, Ref(ctor), location);
            return;
        }
        Unresolved("CALLS", caller, Truncate(display), info.CandidateReason == CandidateReason.None ? "constructor initializer could not be bound" : $"overload resolution: {info.CandidateReason}", location, info.CandidateSymbols);
    }

    private static bool IsCloudSdkType(ITypeSymbol? type)
    {
        if (type == null || type.Locations.Any(l => l.IsInSource)) return false;
        var ns = type.ContainingNamespace?.ToDisplayString() ?? "";
        return ns == "Azure" || ns.StartsWith("Azure.", StringComparison.Ordinal) || ns.StartsWith("Microsoft.Azure.", StringComparison.Ordinal)
            || ns.StartsWith("Microsoft.Data.SqlClient", StringComparison.Ordinal) || ns.StartsWith("Microsoft.Identity.", StringComparison.Ordinal)
            || ns.StartsWith("Microsoft.Extensions.Azure", StringComparison.Ordinal) || ns.StartsWith("Microsoft.DurableTask", StringComparison.Ordinal);
    }

    private void HandleMemberAssignment(AssignmentExpressionSyntax assignment, SemanticModel model)
    {
        if (model.GetSymbolInfo(assignment.Left).Symbol is not ({ } member and (IFieldSymbol or IPropertySymbol { IsIndexer: false })) || !member.Locations.Any(l => l.IsInSource)) return;
        var memberType = member is IFieldSymbol f ? f.Type : ((IPropertySymbol)member).Type;
        var valueType = model.GetTypeInfo(assignment.Right).Type;
        if (!IsCloudSdkType(memberType) && !IsCloudSdkType(valueType)) return;
        var caller = CallerKey(assignment, model);
        if (caller == null) return;
        (_result.Assignments ??= new()).Add(new AssignmentFact
        {
            Caller = caller,
            Member = Ref(member),
            Value = Argument(assignment.Right, model, null, 0),
            Location = ToLocation(assignment.GetLocation()),
        });
    }

    private void HandleMemberInitializer(SyntaxNode declaration, ExpressionSyntax value, SemanticModel model)
    {
        if (model.GetDeclaredSymbol(declaration) is not ({ } member and (IFieldSymbol or IPropertySymbol { IsIndexer: false })) || !member.Locations.Any(l => l.IsInSource)) return;
        var memberType = member is IFieldSymbol f ? f.Type : ((IPropertySymbol)member).Type;
        if (!IsCloudSdkType(memberType) && !IsCloudSdkType(model.GetTypeInfo(value).Type)) return;
        var key = Key(member);
        if (!_declared.Contains(key)) return;
        (_result.Assignments ??= new()).Add(new AssignmentFact
        {
            Caller = key,
            Member = Ref(member),
            Value = Argument(value, model, null, 0),
            Location = ToLocation(declaration.GetLocation()),
        });
    }

    private void HandleCreation(BaseObjectCreationExpressionSyntax creation, SemanticModel model)
    {
        var caller = CallerKey(creation, model);
        if (caller == null) return;
        var location = ToLocation(creation.GetLocation());
        var info = model.GetSymbolInfo(creation);
        var type = model.GetTypeInfo(creation).Type;
        if (info.Symbol is not IMethodSymbol ctor || type == null || type.TypeKind == TypeKind.Error)
        {
            var display = creation is ObjectCreationExpressionSyntax oc ? oc.Type.ToString() : type?.ToDisplayString() ?? "new()";
            if (type?.TypeKind != TypeKind.Delegate) Unresolved("CONSTRUCTS", caller, Truncate(display), "constructed type or constructor could not be bound", location, info.CandidateSymbols);
            return;
        }
        RelateType("CONSTRUCTS", caller, type, location);
        if (!ctor.IsImplicitlyDeclared) Relate("CALLS", caller, Ref(ctor), location);
        if (creation.Parent is ThrowExpressionSyntax or ThrowStatementSyntax) RelateType("THROWS", caller, type, location);
        if (IsCloudSdkType(type))
        {
            var (controlFlow, condition) = ControlFlow(creation);
            (_result.Creations ??= new()).Add(new InvocationFact
            {
                Caller = caller,
                Target = Ref(ctor),
                Arguments = Arguments(creation.ArgumentList, model, model.GetOperation(creation), 0),
                ReceiverType = Ref(type),
                ControlFlow = controlFlow,
                Condition = condition,
                Location = location,
            });
        }
    }

    private void HandleName(SimpleNameSyntax name, SemanticModel model)
    {
        if (name.IsVar || name.Parent is QualifiedNameSyntax q && q.Left == name) return;
        if (name.Ancestors().Any(a => a is UsingDirectiveSyntax or BaseListSyntax || a is BaseNamespaceDeclarationSyntax ns && ns.Name.Span.Contains(name.Span))) return;
        if (IsInvocationTarget(name)) return;
        if (name.Parent is ObjectCreationExpressionSyntax || name.Parent is QualifiedNameSyntax { Parent: ObjectCreationExpressionSyntax }) return;
        if (name.Parent is NameColonSyntax || name.Parent is NameEqualsSyntax) return;

        var info = model.GetSymbolInfo(name);
        var symbol = info.Symbol ?? (info.CandidateReason == CandidateReason.OverloadResolutionFailure && info.CandidateSymbols.Length == 1 && info.CandidateSymbols[0] is IMethodSymbol ? info.CandidateSymbols[0] : null);
        if (symbol == null)
        {
            if (info.CandidateReason == CandidateReason.None && !SyntaxFacts.IsInTypeOnlyContext(name)) return;
            if (info.CandidateReason is CandidateReason.LateBound or CandidateReason.MemberGroup) return;
            var callerKey = CallerKey(name, model);
            if (callerKey != null)
                Unresolved(SyntaxFacts.IsInTypeOnlyContext(name) ? "USES_TYPE" : "REFERENCES", callerKey, Truncate(name.Parent is QualifiedNameSyntax qn ? qn.ToString() : name.ToString()),
                    info.CandidateReason == CandidateReason.None ? "name could not be bound" : $"binding: {info.CandidateReason}", ToLocation(name.GetLocation()), info.CandidateSymbols);
            return;
        }
        if (name.Parent is AttributeSyntax) return;
        string? relation = symbol switch
        {
            INamedTypeSymbol t when t.SpecialType == SpecialType.None && t.TypeKind != TypeKind.Error => "USES_TYPE",
            IFieldSymbol => IsWrite(name) ? "WRITES_FIELD" : "READS_FIELD",
            IPropertySymbol or IEventSymbol => "USES_MEMBER",
            IMethodSymbol { MethodKind: MethodKind.Ordinary or MethodKind.ReducedExtension } => "USES_MEMBER",
            _ => null,
        };
        if (symbol is INamedTypeSymbol { TypeKind: TypeKind.Error } errorType)
        {
            var callerKey = CallerKey(name, model);
            if (callerKey != null) Unresolved("USES_TYPE", callerKey, Truncate(errorType.ToDisplayString()), "type could not be resolved", ToLocation(name.GetLocation()));
            return;
        }
        if (relation == null) return;
        var caller = CallerKey(name, model);
        if (caller == null) return;
        var target = symbol is IMethodSymbol m ? (ISymbol)(m.ReducedFrom ?? m) : symbol;
        if (target is IFieldSymbol && Key(target) == caller) return;
        Relate(relation, caller, Ref(target), ToLocation(name.GetLocation()));
    }

    private static bool IsInvocationTarget(SimpleNameSyntax name)
    {
        SyntaxNode node = name;
        if (node.Parent is MemberAccessExpressionSyntax ma && ma.Name == node) node = ma;
        else if (node.Parent is MemberBindingExpressionSyntax mb && mb.Name == node) node = mb;
        return node.Parent is InvocationExpressionSyntax inv && inv.Expression == node;
    }

    private static bool IsWrite(SimpleNameSyntax name)
    {
        SyntaxNode node = name;
        if (node.Parent is MemberAccessExpressionSyntax ma && ma.Name == node) node = ma;
        return node.Parent switch
        {
            AssignmentExpressionSyntax a => a.Left == node,
            PrefixUnaryExpressionSyntax or PostfixUnaryExpressionSyntax => true,
            ArgumentSyntax arg => !arg.RefKindKeyword.IsKind(SyntaxKind.None),
            _ => false,
        };
    }

    private void RelateType(string type, string source, ITypeSymbol typeSymbol, Location? location)
    {
        foreach (var named in Components(typeSymbol))
        {
            if (named.TypeKind == TypeKind.Error)
            {
                if (string.IsNullOrEmpty(named.Name))
                    Unresolved(type, source, named.ToDisplayString(), "inferred type depends on an unresolved expression", location, cascadedFrom: "(inferred)");
                else
                    Unresolved(type, source, named.ToDisplayString(), "type could not be resolved", location);
                continue;
            }
            if (named.SpecialType != SpecialType.None && type != "CONSTRUCTS") continue;
            Relate(type, source, Ref(named), location);
        }
    }

    private static IEnumerable<INamedTypeSymbol> Components(ITypeSymbol type)
    {
        switch (type)
        {
            case IArrayTypeSymbol array:
                foreach (var t in Components(array.ElementType)) yield return t;
                break;
            case IPointerTypeSymbol pointer:
                foreach (var t in Components(pointer.PointedAtType)) yield return t;
                break;
            case INamedTypeSymbol named:
                yield return named;
                foreach (var arg in named.TypeArguments)
                    if (!SymbolEqualityComparer.Default.Equals(arg, named))
                        foreach (var t in Components(arg)) yield return t;
                break;
        }
    }

    private void Relate(string type, string source, SymRef target, Location? location)
    {
        var key = $"{type}|{source}|{target.Key}";
        if (_relations.TryGetValue(key, out var existing))
        {
            existing.Count++;
            if (location != null && existing.Locations.Count < MaxLocationsPerRelation) existing.Locations.Add(location);
            return;
        }
        var fact = new RelationFact { Type = type, Source = source, Target = target };
        if (location != null) fact.Locations.Add(location);
        _relations[key] = fact;
    }

    private void Unresolved(string type, string source, string display, string reason, Location? location, IEnumerable<ISymbol>? candidates = null, string? cascadedFrom = null)
    {
        if (location == null) return;
        if (!_unresolvedSeen.Add($"{type}|{source}|{display}|{location.Line}|{location.Column}")) return;
        _result.Unresolved.Add(new UnresolvedFact
        {
            DiagnosticId = DiagnosticAt(location, display),
            CascadedFrom = cascadedFrom,
            Type = type,
            Source = source,
            Display = display,
            Reason = reason,
            Candidates = candidates?.Select(c => Key(c)).Distinct().OrderBy(s => s, StringComparer.Ordinal).Take(10).ToList() ?? new(),
            Location = location,
        });
    }

    private AttributeFact? ToAttribute(AttributeData attribute)
    {
        if (attribute.AttributeClass == null) return null;
        var syntax = attribute.ApplicationSyntaxReference?.GetSyntax() as AttributeSyntax;
        var location = syntax == null ? null : ToLocation(syntax.GetLocation());
        var unbound = attribute.AttributeClass.TypeKind == TypeKind.Error || attribute.AttributeConstructor == null;
        if (unbound && syntax?.ArgumentList is { Arguments.Count: > 0 } list && _compilation.SyntaxTrees.Contains(syntax.SyntaxTree))
        {
            var model = _compilation.GetSemanticModel(syntax.SyntaxTree);
            var fallback = list.Arguments.Select(a =>
            {
                var constant = model.GetConstantValue(a.Expression);
                var named = a.NameEquals?.Name.Identifier.Text;
                var value = constant.HasValue
                    ? new ArgValue { Name = named, Kind = constant.Value switch { null => "null", string => "string", bool => "bool", _ => "number" }, Value = Redaction.Value(constant.Value?.ToString()) }
                    : new ArgValue { Name = named, Kind = "expression", Value = Truncate(a.Expression.ToString()) };
                value.Parameter = a.NameColon?.Name.Identifier.Text;
                return value;
            }).ToList();
            return new AttributeFact { Type = Ref(attribute.AttributeClass), Arguments = fallback, Location = location, Unbound = true };
        }
        var parameters = attribute.AttributeConstructor?.Parameters;
        var args = attribute.ConstructorArguments.Select((a, i) =>
        {
            var value = Constant(a, null);
            if (parameters != null && i < parameters.Value.Length) value.Parameter = parameters.Value[i].Name;
            return value;
        }).ToList();
        args.AddRange(attribute.NamedArguments.Select(n => Constant(n.Value, n.Key)));
        return new AttributeFact { Type = Ref(attribute.AttributeClass), Arguments = args, Location = location, Unbound = unbound ? true : null };
    }

    private ArgValue Constant(TypedConstant constant, string? name)
    {
        if (constant.IsNull) return new ArgValue { Name = name, Kind = "null" };
        return constant.Kind switch
        {
            TypedConstantKind.Type => new ArgValue { Name = name, Kind = "type", Type = constant.Value is ITypeSymbol t ? Ref(t) : null },
            TypedConstantKind.Array => new ArgValue { Name = name, Kind = "array", Items = constant.Values.Select(v => Constant(v, null)).ToList() },
            TypedConstantKind.Enum => new ArgValue { Name = name, Kind = "enum", Value = constant.ToCSharpString(), Type = constant.Type == null ? null : Ref(constant.Type) },
            _ => new ArgValue { Name = name, Kind = constant.Value is string ? "string" : constant.Value is bool ? "bool" : "number", Value = Redaction.Value(constant.Value?.ToString()) },
        };
    }

    private SymRef Ref(ITypeSymbol? type)
    {
        while (type is IArrayTypeSymbol or IPointerTypeSymbol)
            type = type is IArrayTypeSymbol a ? a.ElementType : ((IPointerTypeSymbol)type).PointedAtType;
        if (type == null) return new SymRef { Key = "?", Display = "?", QualifiedName = "?", Kind = "Unknown", External = true };
        return Ref((ISymbol)type);
    }

    private SymRef Ref(ISymbol symbol)
    {
        var original = symbol.OriginalDefinition;
        var named = symbol as INamedTypeSymbol;
        return new SymRef
        {
            Key = Key(original),
            Display = symbol.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat),
            QualifiedName = Qualified(original),
            Kind = original switch
            {
                INamedTypeSymbol t => TypeKindName(t),
                ITypeParameterSymbol => "TypeParameter",
                _ => MemberKindName(original),
            },
            Assembly = original.ContainingAssembly?.Name,
            External = !original.Locations.Any(l => l.IsInSource),
            ContainingType = original is INamedTypeSymbol or ITypeParameterSymbol || original.ContainingType == null ? null : Ref(original.ContainingType),
            TypeArguments = named != null && named.IsGenericType && !named.IsUnboundGenericType && !SymbolEqualityComparer.Default.Equals(named, named.OriginalDefinition)
                ? named.TypeArguments.Where(t => t is not ITypeParameterSymbol).Select(t => Ref(t)).ToList()
                : null,
        };
    }

    private string Key(ISymbol symbol)
    {
        var original = symbol.OriginalDefinition;
        if (original is IMethodSymbol { ReducedFrom: { } reduced }) original = reduced;
        var id = DocumentationCommentId.CreateDeclarationId(original);
        var assembly = original.ContainingAssembly?.Name ?? "?";
        if (_frameworkAssemblies.Contains(assembly) && !original.Locations.Any(l => l.IsInSource)) assembly = FrameworkAssembly;
        return $"{assembly}::{id ?? original.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)}";
    }

    private static readonly SymbolDisplayFormat QualifiedFormat = new(
        typeQualificationStyle: SymbolDisplayTypeQualificationStyle.NameAndContainingTypesAndNamespaces,
        genericsOptions: SymbolDisplayGenericsOptions.IncludeTypeParameters,
        memberOptions: SymbolDisplayMemberOptions.IncludeContainingType | SymbolDisplayMemberOptions.IncludeParameters,
        parameterOptions: SymbolDisplayParameterOptions.IncludeType,
        miscellaneousOptions: SymbolDisplayMiscellaneousOptions.UseSpecialTypes);

    private static string Qualified(ISymbol symbol) => symbol.ToDisplayString(QualifiedFormat);

    private static string Namespace(ISymbol symbol) =>
        symbol.ContainingNamespace is { IsGlobalNamespace: false } ns ? ns.ToDisplayString() : "";

    private static string TypeKindName(INamedTypeSymbol type) => type.TypeKind switch
    {
        TypeKind.Class when type.IsRecord => "Record",
        TypeKind.Struct when type.IsRecord => "RecordStruct",
        TypeKind.Class => "Class",
        TypeKind.Interface => "Interface",
        TypeKind.Struct => "Struct",
        TypeKind.Enum => "Enum",
        TypeKind.Delegate => "Delegate",
        TypeKind.Error => "Error",
        _ => type.TypeKind.ToString(),
    };

    private static string MemberKindName(ISymbol symbol) => symbol switch
    {
        IMethodSymbol { MethodKind: MethodKind.Constructor or MethodKind.StaticConstructor } => "Constructor",
        IMethodSymbol { MethodKind: MethodKind.UserDefinedOperator or MethodKind.Conversion } => "Operator",
        IMethodSymbol { MethodKind: MethodKind.Destructor } => "Destructor",
        IMethodSymbol => "Method",
        IPropertySymbol { IsIndexer: true } => "Indexer",
        IPropertySymbol => "Property",
        IFieldSymbol { ContainingType.TypeKind: TypeKind.Enum } => "EnumMember",
        IFieldSymbol => "Field",
        IEventSymbol => "Event",
        INamespaceSymbol => "Namespace",
        _ => symbol.Kind.ToString(),
    };

    private static List<string> Modifiers(ISymbol symbol)
    {
        var mods = new List<string>();
        if (symbol.IsStatic) mods.Add("static");
        if (symbol.IsAbstract && symbol is not INamedTypeSymbol { TypeKind: TypeKind.Interface }) mods.Add("abstract");
        if (symbol.IsVirtual) mods.Add("virtual");
        if (symbol.IsOverride) mods.Add("override");
        if (symbol.IsSealed && symbol is not INamedTypeSymbol { TypeKind: TypeKind.Struct or TypeKind.Enum or TypeKind.Delegate }) mods.Add("sealed");
        if (symbol.IsExtern) mods.Add("extern");
        if (symbol is IMethodSymbol m)
        {
            if (m.IsAsync) mods.Add("async");
            if (m.IsExtensionMethod) mods.Add("extension");
            if (m.IsGenericMethod) mods.Add("generic");
            if (m.PartialDefinitionPart != null || m.PartialImplementationPart != null) mods.Add("partial");
        }
        if (symbol is INamedTypeSymbol t)
        {
            if (t.IsGenericType) mods.Add("generic");
            if (t.DeclaringSyntaxReferences.Length > 1) mods.Add("partial");
            if (t.ContainingType != null) mods.Add("nested");
        }
        if (symbol is IFieldSymbol f)
        {
            if (f.IsConst) mods.Add("const");
            if (f.IsReadOnly) mods.Add("readonly");
        }
        if (symbol is IPropertySymbol p && p.IsRequired) mods.Add("required");
        return mods;
    }

    private static List<string> BaseChain(INamedTypeSymbol type)
    {
        var chain = new List<string>();
        for (var b = type.BaseType; b != null && b.SpecialType != SpecialType.System_Object; b = b.BaseType)
            chain.Add(Qualified(b.OriginalDefinition));
        return chain;
    }

    private bool IsGenerated(ISymbol symbol) =>
        symbol.Locations.Where(l => l.IsInSource).All(l => l.SourceTree?.FilePath is { } p && (Path.GetFileName(p).Contains(".g.") || Path.GetFileName(p).Contains(".Designer.", StringComparison.OrdinalIgnoreCase) || !p.StartsWith(_root)));

    private Location? SourceLocation(ISymbol symbol)
    {
        var loc = symbol.Locations.FirstOrDefault(l => l.IsInSource);
        if (loc == null) return null;
        var syntax = symbol.DeclaringSyntaxReferences.FirstOrDefault(r => r.SyntaxTree == loc.SourceTree)?.GetSyntax();
        var location = ToLocation(loc);
        if (syntax == null || symbol is IFieldSymbol or IEventSymbol) return location;
        var span = syntax.GetLocation().GetLineSpan();
        return new Location { File = location.File, Line = location.Line, Column = location.Column, EndLine = span.EndLinePosition.Line + 1, EndColumn = span.EndLinePosition.Character + 1 };
    }

    private Location ToLocation(Microsoft.CodeAnalysis.Location location)
    {
        var span = location.GetLineSpan();
        return new Location
        {
            File = Rel(span.Path),
            Line = span.StartLinePosition.Line + 1,
            Column = span.StartLinePosition.Character + 1,
            EndLine = span.EndLinePosition.Line + 1,
            EndColumn = span.EndLinePosition.Character + 1,
        };
    }

    private string Rel(string path) => path.StartsWith(_root) ? Path.GetRelativePath(_root, path).Replace('\\', '/') : path;

    private static string Truncate(string text)
    {
        var single = Redaction.Expression(string.Join(' ', text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)));
        return single.Length > 160 ? single[..160] + "…" : single;
    }
}
