namespace Vogoban.Roslyn;

public static class FrameworkMerge
{
    private const int MaxLocations = 10;

    public static void Into(ProjectResult target, List<(string Tfm, ProjectResult Result)> perFramework)
    {
        var all = perFramework.Select(p => p.Tfm).ToList();
        var symbolTfms = new Dictionary<string, List<string>>();
        var relationTfms = new Dictionary<string, List<string>>();
        var unresolvedTfms = new Dictionary<string, List<string>>();
        var symbols = new Dictionary<string, SymbolFact>();
        var relations = new Dictionary<string, RelationFact>();
        var unresolved = new Dictionary<string, UnresolvedFact>();
        var invocations = new Dictionary<string, InvocationFact>();
        var creations = new Dictionary<string, InvocationFact>();
        var assignments = new Dictionary<string, AssignmentFact>();

        foreach (var (tfm, result) in perFramework)
        {
            foreach (var s in result.Symbols)
            {
                symbols.TryAdd(s.Key, s);
                Add(symbolTfms, s.Key, tfm);
            }
            foreach (var r in result.Relations)
            {
                var key = $"{r.Type}|{r.Source}|{r.Target.Key}";
                Add(relationTfms, key, tfm);
                if (!relations.TryGetValue(key, out var existing))
                {
                    relations[key] = r;
                    continue;
                }
                existing.Count = Math.Max(existing.Count, r.Count);
                foreach (var loc in r.Locations)
                    if (existing.Locations.Count < MaxLocations && !existing.Locations.Any(l => l.File == loc.File && l.Line == loc.Line && l.Column == loc.Column))
                        existing.Locations.Add(loc);
            }
            foreach (var u in result.Unresolved)
            {
                var key = $"{u.Type}|{u.Source}|{u.Display}|{u.Location.File}|{u.Location.Line}|{u.Location.Column}";
                unresolved.TryAdd(key, u);
                Add(unresolvedTfms, key, tfm);
            }
            foreach (var i in result.Invocations)
                invocations.TryAdd($"{i.Caller}|{i.Target.Key}|{i.Location.File}|{i.Location.Line}|{i.Location.Column}|{i.Location.EndLine}|{i.Location.EndColumn}", i);
            foreach (var c in result.Creations ?? new())
                creations.TryAdd($"{c.Caller}|{c.Target.Key}|{c.Location.File}|{c.Location.Line}|{c.Location.Column}|{c.Location.EndLine}|{c.Location.EndColumn}", c);
            foreach (var a in result.Assignments ?? new())
                assignments.TryAdd($"{a.Caller}|{a.Member.Key}|{a.Location.File}|{a.Location.Line}|{a.Location.Column}", a);
            foreach (var d in result.Diagnostics)
                if (target.Diagnostics.Count < 25 && !target.Diagnostics.Any(x => x.Id == d.Id && x.File == d.File && x.Line == d.Line))
                    target.Diagnostics.Add(d);
            target.CompilerErrors = Math.Max(target.CompilerErrors, result.CompilerErrors);
            target.CompilerWarnings = Math.Max(target.CompilerWarnings, result.CompilerWarnings);
        }

        List<string>? Conditional(List<string> present) => present.Count == all.Count ? null : present;
        foreach (var (key, s) in symbols) s.TargetFrameworks = Conditional(symbolTfms[key]);
        foreach (var (key, r) in relations) r.TargetFrameworks = Conditional(relationTfms[key]);
        foreach (var (key, u) in unresolved) u.TargetFrameworks = Conditional(unresolvedTfms[key]);

        target.Symbols.AddRange(symbols.Values);
        target.Relations.AddRange(relations.Values.OrderBy(r => r.Type, StringComparer.Ordinal).ThenBy(r => r.Source, StringComparer.Ordinal).ThenBy(r => r.Target.Key, StringComparer.Ordinal));
        target.Unresolved.AddRange(unresolved.Values);
        target.Invocations.AddRange(invocations.Values);
        if (creations.Count > 0) target.Creations = creations.Values.ToList();
        if (assignments.Count > 0) target.Assignments = assignments.Values.ToList();
        target.ReferenceSources.AddRange(target.Frameworks.Select(f => f.ReferencePack).Distinct());
    }

    private static void Add(Dictionary<string, List<string>> map, string key, string tfm)
    {
        if (!map.TryGetValue(key, out var list)) map[key] = list = new();
        if (!list.Contains(tfm)) list.Add(tfm);
    }
}
