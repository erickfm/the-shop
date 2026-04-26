using System;
using System.Collections.Generic;
using System.IO;
using HSDRaw;
using HSDRaw.Common;

if (args.Length < 1)
{
    Console.Error.WriteLine("usage: the-shop-hsd <inspect|shrink-csp> ...");
    return 2;
}

return args[0] switch
{
    "inspect" => Inspect(args),
    "shrink-csp" => ShrinkCsp(args),
    _ => Usage(),
};

static int Usage()
{
    Console.Error.WriteLine("commands:");
    Console.Error.WriteLine("  inspect <input.dat>");
    Console.Error.WriteLine("  shrink-csp <input.dat> <output.dat> <replacement.png>");
    return 2;
}

static int Inspect(string[] args)
{
    if (args.Length < 2) return Usage();
    var path = args[1];
    var file = new HSDRawFile(path);
    Console.WriteLine($"file: {path}");
    Console.WriteLine($"size on disk: {new FileInfo(path).Length} bytes");
    Console.WriteLine($"roots: {file.Roots.Count}");
    foreach (var root in file.Roots)
    {
        Console.WriteLine($"  root: {root.Name} ({root.Data?.GetType().Name ?? "null"})");
    }

    var textures = new List<HSD_TOBJ>();
    foreach (var root in file.Roots)
    {
        if (root.Data == null) continue;
        WalkAccessor(root.Data, textures, new HashSet<int>());
    }
    Console.WriteLine($"texture count: {textures.Count}");
    long totalImageBytes = 0;
    int idx = 0;
    foreach (var t in textures)
    {
        var img = t.ImageData;
        int w = img?.Width ?? 0;
        int h = img?.Height ?? 0;
        var fmt = img?.Format.ToString() ?? "?";
        int bytes = img?.ImageData?.Length ?? 0;
        totalImageBytes += bytes;
        Console.WriteLine($"  [{idx}] {w}x{h} fmt={fmt} bytes={bytes}");
        idx++;
    }
    Console.WriteLine($"total image bytes: {totalImageBytes}");
    return 0;
}

static int ShrinkCsp(string[] args)
{
    Console.Error.WriteLine("shrink-csp not yet implemented; run inspect first to verify CSP presence");
    return 3;
}

static void WalkAccessor(HSDAccessor accessor, List<HSD_TOBJ> textures, HashSet<int> seen)
{
    if (accessor == null) return;
    int hash = System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(accessor);
    if (!seen.Add(hash)) return;

    if (accessor is HSD_TOBJ tobj)
    {
        textures.Add(tobj);
    }

    var struct_ = accessor._s;
    if (struct_ == null) return;
    foreach (var kv in struct_.References)
    {
        var sub = kv.Value;
        if (sub == null) continue;
        var acc = new HSDAccessor();
        acc._s = sub;
        WalkAccessor(acc, textures, seen);
    }
}
