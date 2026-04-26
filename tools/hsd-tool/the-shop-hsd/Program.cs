using System;
using System.Collections.Generic;
using System.IO;
using HSDRaw;
using HSDRaw.Common;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;

if (args.Length < 1)
{
    Console.Error.WriteLine("usage: the-shop-hsd <inspect|thumbnail|dump-textures> ...");
    return 2;
}

return args[0] switch
{
    "inspect" => Inspect(args),
    "thumbnail" => Thumbnail(args),
    "dump-textures" => DumpTextures(args),
    _ => Usage(),
};

static int Usage()
{
    Console.Error.WriteLine("commands:");
    Console.Error.WriteLine("  inspect <input.dat>");
    Console.Error.WriteLine("  thumbnail <input.dat> <output.png>");
    Console.Error.WriteLine("  dump-textures <input.dat> <output_dir>");
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
    var textures = CollectTextures(file);
    Console.WriteLine($"texture count: {textures.Count}");
    int idx = 0;
    foreach (var t in textures)
    {
        var img = t.ImageData;
        int w = img?.Width ?? 0;
        int h = img?.Height ?? 0;
        var fmt = img?.Format.ToString() ?? "?";
        int bytes = img?.ImageData?.Length ?? 0;
        Console.WriteLine($"  [{idx}] {w}x{h} fmt={fmt} bytes={bytes}");
        idx++;
    }
    return 0;
}

static int Thumbnail(string[] args)
{
    if (args.Length < 3) return Usage();
    var input = args[1];
    var output = args[2];
    var file = new HSDRawFile(input);
    var textures = CollectTextures(file);
    if (textures.Count == 0)
    {
        Console.Error.WriteLine("no textures found");
        return 4;
    }
    HSD_TOBJ? best = null;
    int bestArea = -1;
    foreach (var t in textures)
    {
        var img = t.ImageData;
        if (img == null) continue;
        int w = img.Width, h = img.Height;
        if (w > 256 || h > 256) continue;
        if (w != h) continue;
        if (!IsPowerOfTwo(w)) continue;
        int area = w * h;
        if (area > bestArea)
        {
            bestArea = area;
            best = t;
        }
    }
    if (best == null)
    {
        foreach (var t in textures)
        {
            var img = t.ImageData;
            if (img == null) continue;
            int area = img.Width * img.Height;
            if (area > bestArea)
            {
                bestArea = area;
                best = t;
            }
        }
    }
    if (best == null)
    {
        Console.Error.WriteLine("no decodable textures found");
        return 4;
    }
    return SaveTextureAsPng(best, output);
}

static int DumpTextures(string[] args)
{
    if (args.Length < 3) return Usage();
    var input = args[1];
    var dir = args[2];
    Directory.CreateDirectory(dir);
    var file = new HSDRawFile(input);
    var textures = CollectTextures(file);
    int idx = 0;
    int written = 0;
    foreach (var t in textures)
    {
        var img = t.ImageData;
        if (img == null)
        {
            idx++;
            continue;
        }
        var output = Path.Combine(dir, $"tex_{idx:D3}_{img.Width}x{img.Height}.png");
        if (SaveTextureAsPng(t, output) == 0)
        {
            written++;
        }
        idx++;
    }
    Console.WriteLine($"wrote {written}/{textures.Count} textures to {dir}");
    return written > 0 ? 0 : 4;
}

static bool IsPowerOfTwo(int x) => x > 0 && (x & (x - 1)) == 0;

static int SaveTextureAsPng(HSD_TOBJ tobj, string output)
{
    byte[] rgba;
    int w, h;
    try
    {
        rgba = tobj.GetDecodedImageData();
        w = tobj.ImageData!.Width;
        h = tobj.ImageData!.Height;
    }
    catch (Exception e)
    {
        Console.Error.WriteLine($"decode failed: {e.Message}");
        return 5;
    }
    if (rgba == null || rgba.Length < w * h * 4)
    {
        Console.Error.WriteLine($"decoded buffer too small: {rgba?.Length ?? 0} for {w}x{h}");
        return 5;
    }
    using (var image = Image.LoadPixelData<Rgba32>(rgba.AsSpan(0, w * h * 4), w, h))
    {
        Directory.CreateDirectory(Path.GetDirectoryName(output) ?? ".");
        image.SaveAsPng(output);
    }
    return 0;
}

static List<HSD_TOBJ> CollectTextures(HSDRawFile file)
{
    var textures = new List<HSD_TOBJ>();
    var seen = new HashSet<int>();
    foreach (var root in file.Roots)
    {
        if (root.Data is HSD_JOBJ jobj)
        {
            WalkJobj(jobj, textures, seen);
        }
    }
    return textures;
}

static void WalkJobj(HSD_JOBJ? jobj, List<HSD_TOBJ> textures, HashSet<int> seen)
{
    if (jobj == null) return;
    int hash = System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(jobj);
    if (!seen.Add(hash)) return;

    var dobj = jobj.Dobj;
    while (dobj != null)
    {
        var mobj = dobj.Mobj;
        if (mobj != null)
        {
            var tobj = mobj.Textures;
            while (tobj != null)
            {
                int thash = System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(tobj);
                if (seen.Add(thash))
                {
                    textures.Add(tobj);
                }
                tobj = tobj.Next;
            }
        }
        dobj = dobj.Next;
    }

    WalkJobj(jobj.Child, textures, seen);
    WalkJobj(jobj.Next, textures, seen);
}
