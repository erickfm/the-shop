using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Numerics;
using HSDRaw;
using HSDRaw.Common;
using HSDRaw.GX;
using HSDRaw.Tools;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;

if (args.Length < 1)
{
    Console.Error.WriteLine("usage: the-shop-hsd <inspect|thumbnail|dump-textures|to-obj> ...");
    return 2;
}

return args[0] switch
{
    "inspect" => Inspect(args),
    "thumbnail" => Thumbnail(args),
    "dump-textures" => DumpTextures(args),
    "to-obj" => ToObj(args),
    _ => Usage(),
};

static int Usage()
{
    Console.Error.WriteLine("commands:");
    Console.Error.WriteLine("  inspect <input.dat>");
    Console.Error.WriteLine("  thumbnail <input.dat> <output.png>");
    Console.Error.WriteLine("  dump-textures <input.dat> <output_dir>");
    Console.Error.WriteLine("  to-obj <input.dat> <output.obj>");
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

static int ToObj(string[] args)
{
    if (args.Length < 3) return Usage();
    var input = args[1];
    var output = args[2];

    var file = new HSDRawFile(input);
    var positions = new List<Vector3>();
    var normals = new List<Vector3>();
    var uvs = new List<Vector2>();
    var faces = new List<(int v, int n, int t)[]>();

    var jobjWorlds = new Dictionary<int, Matrix4x4>();
    foreach (var root in file.Roots)
    {
        if (root.Data is HSD_JOBJ rootJobj)
        {
            BuildJobjWorlds(rootJobj, Matrix4x4.Identity, jobjWorlds, new HashSet<int>());
        }
    }

    foreach (var root in file.Roots)
    {
        if (root.Data is HSD_JOBJ rootJobj)
        {
            WalkAndEmit(rootJobj, jobjWorlds, positions, normals, uvs, faces, new HashSet<int>());
        }
    }

    Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(output)) ?? ".");
    using (var w = new StreamWriter(output))
    {
        w.WriteLine("# the-shop-hsd OBJ export");
        w.WriteLine($"# source: {Path.GetFileName(input)}");
        w.WriteLine($"# vertices: {positions.Count}, faces: {faces.Count}");

        foreach (var p in positions)
            w.WriteLine($"v {F(p.X)} {F(p.Y)} {F(p.Z)}");
        foreach (var n in normals)
            w.WriteLine($"vn {F(n.X)} {F(n.Y)} {F(n.Z)}");
        foreach (var uv in uvs)
            w.WriteLine($"vt {F(uv.X)} {F(1 - uv.Y)}");

        w.WriteLine("o character");
        foreach (var face in faces)
        {
            var s = "f";
            foreach (var t in face)
            {
                int vi = t.v + 1;
                int ti = t.t + 1;
                int ni = t.n + 1;
                s += $" {vi}/{(t.t < 0 ? "" : ti.ToString())}/{(t.n < 0 ? "" : ni.ToString())}";
            }
            w.WriteLine(s);
        }
    }

    Console.WriteLine($"wrote {positions.Count} verts, {faces.Count} faces to {output}");
    return positions.Count > 0 && faces.Count > 0 ? 0 : 4;
}

static string F(float v) => v.ToString("0.######", CultureInfo.InvariantCulture);

static Matrix4x4 EulerMatrix(float X, float Y, float Z)
{
    float sx = MathF.Sin(X), cx = MathF.Cos(X);
    float sy = MathF.Sin(Y), cy = MathF.Cos(Y);
    float sz = MathF.Sin(Z), cz = MathF.Cos(Z);
    return new Matrix4x4(
        cy * cz,                    cy * sz,                    -sy,     0,
        cz * sx * sy - cx * sz,     sz * sx * sy + cx * cz,     sx * cy, 0,
        cz * cx * sy + sx * sz,     sz * cx * sy - sx * cz,     cx * cy, 0,
        0,                          0,                          0,       1
    );
}

static Matrix4x4 LocalMatrix(HSD_JOBJ j)
{
    var s = Matrix4x4.CreateScale(j.SX, j.SY, j.SZ);
    var r = EulerMatrix(j.RX, j.RY, j.RZ);
    var t = Matrix4x4.CreateTranslation(j.TX, j.TY, j.TZ);
    return s * r * t;
}

static void BuildJobjWorlds(
    HSD_JOBJ? jobj,
    Matrix4x4 parentWorld,
    Dictionary<int, Matrix4x4> map,
    HashSet<int> seen)
{
    if (jobj == null) return;
    int hash = System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(jobj);
    if (!seen.Add(hash)) return;

    var world = LocalMatrix(jobj) * parentWorld;
    map[hash] = world;

    BuildJobjWorlds(jobj.Child, world, map, seen);
    BuildJobjWorlds(jobj.Next, parentWorld, map, seen);
}

static Matrix4x4 GetWorld(HSD_JOBJ? j, Dictionary<int, Matrix4x4> jobjWorlds)
{
    if (j == null) return Matrix4x4.Identity;
    int h = System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(j);
    return jobjWorlds.TryGetValue(h, out var m) ? m : Matrix4x4.Identity;
}

static void WalkAndEmit(
    HSD_JOBJ? jobj,
    Dictionary<int, Matrix4x4> jobjWorlds,
    List<Vector3> positions,
    List<Vector3> normals,
    List<Vector2> uvs,
    List<(int v, int n, int t)[]> faces,
    HashSet<int> seen)
{
    if (jobj == null) return;
    int hash = System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(jobj);
    if (!seen.Add(hash)) return;

    var parentTransform = GetWorld(jobj, jobjWorlds);

    bool skipEnvelope = Environment.GetEnvironmentVariable("THE_SHOP_HSD_SKIP_ENVELOPE") == "1";
    var dobj = jobj.Dobj;
    while (dobj != null)
    {
        var pobj = dobj.Pobj;
        while (pobj != null)
        {
            bool isEnvelope = pobj.Flags.HasFlag(POBJ_FLAG.ENVELOPE)
                || pobj.HasAttribute(GXAttribName.GX_VA_PNMTXIDX);
            if (skipEnvelope && isEnvelope)
            {
                pobj = pobj.Next;
                continue;
            }
            try
            {
                EmitPobj(pobj, jobj, parentTransform, jobjWorlds, positions, normals, uvs, faces);
            }
            catch (Exception e)
            {
                Console.Error.WriteLine($"skipping POBJ: {e.Message}");
            }
            pobj = pobj.Next;
        }
        dobj = dobj.Next;
    }

    WalkAndEmit(jobj.Child, jobjWorlds, positions, normals, uvs, faces, seen);
    WalkAndEmit(jobj.Next, jobjWorlds, positions, normals, uvs, faces, seen);
}

static void EmitPobj(
    HSD_POBJ pobj,
    HSD_JOBJ parent,
    Matrix4x4 parentTransform,
    Dictionary<int, Matrix4x4> jobjWorlds,
    List<Vector3> positions,
    List<Vector3> normals,
    List<Vector2> uvs,
    List<(int v, int n, int t)[]> faces)
{
    var dl = pobj.ToDisplayList();
    var allVerts = GX_VertexAccessor.GetDecodedVertices(dl, pobj);
    var envelopes = pobj.EnvelopeWeights;
    bool hasPNMTXIDX = pobj.HasAttribute(GXAttribName.GX_VA_PNMTXIDX);
    bool isSkeleton = parent.Flags.HasFlag(JOBJ_FLAG.SKELETON)
        || parent.Flags.HasFlag(JOBJ_FLAG.SKELETON_ROOT)
        || pobj.Flags.HasFlag(POBJ_FLAG.UNKNOWN2);
    bool isShapesetAverage = pobj.Flags.HasFlag(POBJ_FLAG.SHAPESET_AVERAGE);

    var singleBind = pobj.SingleBoundJOBJ;
    var singleBindTransform = GetWorld(singleBind, jobjWorlds);

    int offset = 0;
    foreach (var pg in dl.Primitives)
    {
        int count = pg.Indices.Length;
        if (offset + count > allVerts.Length) break;

        var pgVerts = new GX_Vertex[count];
        Array.Copy(allVerts, offset, pgVerts, 0, count);
        offset += count;

        int baseIdx = positions.Count;
        for (int i = 0; i < pgVerts.Length; i++)
        {
            var gv = pgVerts[i];

            var singleMatrix = Matrix4x4.Identity;
            if (hasPNMTXIDX && envelopes != null)
            {
                int eIdx = gv.PNMTXIDX / 3;
                if (eIdx >= 0 && eIdx < envelopes.Length)
                {
                    var en = envelopes[eIdx];
                    if (en.EnvelopeCount > 0
                        && en.GetWeightAt(0) == 1
                        && en.GetJOBJAt(0) != null)
                    {
                        singleMatrix = GetWorld(en.GetJOBJAt(0), jobjWorlds);
                    }
                    else
                    {
                        singleMatrix = parentTransform;
                    }
                }
            }

            var localPos = new Vector3(gv.POS.X, gv.POS.Y, gv.POS.Z);
            var localNrm = new Vector3(gv.NRM.X, gv.NRM.Y, gv.NRM.Z);

            string mode = Environment.GetEnvironmentVariable("THE_SHOP_HSD_MODE") ?? "default";
            if (mode == "raw")
            {
            }
            else if (mode == "envelope-mat")
            {
                if (hasPNMTXIDX)
                {
                    localPos = Vector3.Transform(localPos, singleMatrix);
                    localNrm = Vector3.TransformNormal(localNrm, singleMatrix);
                }
                else
                {
                    localPos = Vector3.Transform(localPos, parentTransform);
                    localNrm = Vector3.TransformNormal(localNrm, parentTransform);
                }
                localPos = Vector3.Transform(localPos, singleBindTransform);
                localNrm = Vector3.TransformNormal(localNrm, singleBindTransform);
            }
            else
            {
                if (!isShapesetAverage && !hasPNMTXIDX)
                {
                    localPos = Vector3.Transform(localPos, parentTransform);
                    localNrm = Vector3.TransformNormal(localNrm, parentTransform);
                }
                if (isSkeleton)
                {
                    localPos = Vector3.Transform(localPos, singleMatrix);
                    localNrm = Vector3.TransformNormal(localNrm, singleMatrix);
                }
                localPos = Vector3.Transform(localPos, singleBindTransform);
                localNrm = Vector3.TransformNormal(localNrm, singleBindTransform);
            }

            if (localNrm.LengthSquared() > 1e-12f)
                localNrm = Vector3.Normalize(localNrm);

            positions.Add(localPos);
            normals.Add(localNrm);
            uvs.Add(new Vector2(gv.TEX0.X, gv.TEX0.Y));
        }

        EmitFaces(pg.PrimitiveType, baseIdx, count, faces);
    }
}

static void EmitFaces(
    GXPrimitiveType type,
    int baseIdx,
    int count,
    List<(int v, int n, int t)[]> faces)
{
    switch (type)
    {
        case GXPrimitiveType.Triangles:
            for (int i = 0; i + 2 < count; i += 3)
                faces.Add(Tri(baseIdx + i, baseIdx + i + 1, baseIdx + i + 2));
            break;
        case GXPrimitiveType.TriangleStrip:
            for (int i = 0; i + 2 < count; i++)
            {
                if ((i & 1) == 0)
                    faces.Add(Tri(baseIdx + i, baseIdx + i + 1, baseIdx + i + 2));
                else
                    faces.Add(Tri(baseIdx + i + 1, baseIdx + i, baseIdx + i + 2));
            }
            break;
        case GXPrimitiveType.TriangleFan:
            for (int i = 1; i + 1 < count; i++)
                faces.Add(Tri(baseIdx, baseIdx + i, baseIdx + i + 1));
            break;
        case GXPrimitiveType.Quads:
            for (int i = 0; i + 3 < count; i += 4)
            {
                faces.Add(Tri(baseIdx + i, baseIdx + i + 1, baseIdx + i + 2));
                faces.Add(Tri(baseIdx + i, baseIdx + i + 2, baseIdx + i + 3));
            }
            break;
    }
}

static (int v, int n, int t)[] Tri(int a, int b, int c) =>
    new[] { (a, a, a), (b, b, b), (c, c, c) };
