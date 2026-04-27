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
using SharpGLTF.Geometry;
using SharpGLTF.Geometry.VertexTypes;
using SharpGLTF.Materials;
using SharpGLTF.Scenes;

if (args.Length < 1)
{
    Console.Error.WriteLine("usage: the-shop-hsd <inspect|thumbnail|dump-textures|to-obj|to-gltf> ...");
    return 2;
}

return args[0] switch
{
    "inspect" => Inspect(args),
    "thumbnail" => Thumbnail(args),
    "dump-textures" => DumpTextures(args),
    "to-obj" => ToObj(args),
    "to-gltf" => ToGltf(args),
    _ => Usage(),
};

static int Usage()
{
    Console.Error.WriteLine("commands:");
    Console.Error.WriteLine("  inspect <input.dat>");
    Console.Error.WriteLine("  thumbnail <input.dat> <output.png>");
    Console.Error.WriteLine("  dump-textures <input.dat> <output_dir>");
    Console.Error.WriteLine("  to-obj <input.dat> <output.obj>");
    Console.Error.WriteLine("  to-gltf <input.dat> <output.glb>");
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
    // HAL textures decode to BGRA byte order via HSD_TOBJ.GetDecodedImageData
    // (HSDRawViewer's SaveImagePNG also uses Bgra32). Reading as Rgba32 swaps
    // R<->B which makes orange skins render as blue.
    using (var image = Image.LoadPixelData<Bgra32>(rgba.AsSpan(0, w * h * 4), w, h))
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
    var vertColors = new List<Vector3>();
    var vertMatIdx = new List<int>();
    var facesByMat = new Dictionary<int, List<(int v, int n, int t)[]>>();
    var materials = new List<MaterialEntry>();
    var mobjToMatIdx = new Dictionary<int, int>();
    var tobjHashToFilename = new Dictionary<int, string>();

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
            WalkAndEmit(
                rootJobj, jobjWorlds,
                materials, mobjToMatIdx, tobjHashToFilename,
                positions, normals, uvs, vertColors, vertMatIdx,
                facesByMat,
                new HashSet<int>());
        }
    }

    if (Environment.GetEnvironmentVariable("THE_SHOP_HSD_LOG_MATERIALS") == "1")
        LogMaterials(materials);

    var outDir = Path.GetDirectoryName(Path.GetFullPath(output)) ?? ".";
    Directory.CreateDirectory(outDir);

    var baseName = Path.GetFileNameWithoutExtension(output);
    var mtlName = baseName + ".mtl";
    var mtlPath = Path.Combine(outDir, mtlName);

    int totalFaces = 0;
    foreach (var bucket in facesByMat.Values) totalFaces += bucket.Count;

    using (var w = new StreamWriter(output))
    {
        w.WriteLine("# the-shop-hsd OBJ export");
        w.WriteLine($"# source: {Path.GetFileName(input)}");
        w.WriteLine($"# vertices: {positions.Count}, faces: {totalFaces}, materials: {materials.Count}");
        w.WriteLine($"mtllib {mtlName}");

        for (int i = 0; i < positions.Count; i++)
        {
            var p = positions[i];
            int mi = i < vertMatIdx.Count ? vertMatIdx[i] : -1;
            bool textured = mi >= 0 && mi < materials.Count && materials[mi].HasDiffuseTexture;
            if (textured)
            {
                w.WriteLine($"v {F(p.X)} {F(p.Y)} {F(p.Z)}");
            }
            else
            {
                var c = i < vertColors.Count ? vertColors[i] : new Vector3(0.8f, 0.8f, 0.85f);
                w.WriteLine($"v {F(p.X)} {F(p.Y)} {F(p.Z)} {F(c.X)} {F(c.Y)} {F(c.Z)}");
            }
        }
        foreach (var n in normals)
            w.WriteLine($"vn {F(n.X)} {F(n.Y)} {F(n.Z)}");
        foreach (var uv in uvs)
            w.WriteLine($"vt {F(uv.X)} {F(1 - uv.Y)}");

        w.WriteLine("o character");
        foreach (var (matIdx, bucket) in facesByMat)
        {
            if (bucket.Count == 0) continue;
            var matName = matIdx >= 0 && matIdx < materials.Count ? materials[matIdx].Name : "mat_default";
            w.WriteLine($"g {matName}");
            w.WriteLine($"usemtl {matName}");
            foreach (var face in bucket)
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
    }

    WriteMtl(mtlPath, materials);
    int texturesWritten = ExportMaterialTextures(materials, outDir);

    Console.WriteLine($"wrote {positions.Count} verts, {totalFaces} faces, {materials.Count} mats, {texturesWritten} textures to {outDir}");
    return positions.Count > 0 && totalFaces > 0 ? 0 : 4;
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
    List<MaterialEntry> materials,
    Dictionary<int, int> mobjToMatIdx,
    Dictionary<int, string> tobjHashToFilename,
    List<Vector3> positions,
    List<Vector3> normals,
    List<Vector2> uvs,
    List<Vector3> vertColors,
    List<int> vertMatIdx,
    Dictionary<int, List<(int v, int n, int t)[]>> facesByMat,
    HashSet<int> seen)
{
    if (jobj == null) return;
    int hash = System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(jobj);
    if (!seen.Add(hash)) return;

    var parentTransform = GetWorld(jobj, jobjWorlds);

    bool skipEnvelope = Environment.GetEnvironmentVariable("THE_SHOP_HSD_SKIP_ENVELOPE") == "1";
    bool logPobjFlags = Environment.GetEnvironmentVariable("THE_SHOP_HSD_LOG_POBJ_FLAGS") == "1";
    var dobj = jobj.Dobj;
    while (dobj != null)
    {
        var matIdx = GetOrAddMaterial(dobj.Mobj, mobjToMatIdx, materials, tobjHashToFilename);
        var matEntry = materials[matIdx];
        if (!facesByMat.ContainsKey(matIdx))
            facesByMat[matIdx] = new List<(int v, int n, int t)[]>();
        var faceBucket = facesByMat[matIdx];

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
            if (logPobjFlags)
            {
                bool unknown2 = pobj.Flags.HasFlag(POBJ_FLAG.UNKNOWN2);
                bool sk = jobj.Flags.HasFlag(JOBJ_FLAG.SKELETON);
                bool skr = jobj.Flags.HasFlag(JOBJ_FLAG.SKELETON_ROOT);
                bool sba = pobj.Flags.HasFlag(POBJ_FLAG.SHAPESET_AVERAGE);
                Console.Error.WriteLine(
                    $"  pobj {matEntry.Name} env={isEnvelope} unk2={unknown2} skel={sk} skelRoot={skr} shapeAvg={sba} singleBind={(pobj.SingleBoundJOBJ != null)}");
            }
            try
            {
                EmitPobj(pobj, jobj, parentTransform, jobjWorlds, matEntry, matIdx,
                    positions, normals, uvs, vertColors, vertMatIdx, faceBucket);
            }
            catch (Exception e)
            {
                Console.Error.WriteLine($"skipping POBJ: {e.Message}");
            }
            pobj = pobj.Next;
        }
        dobj = dobj.Next;
    }

    WalkAndEmit(jobj.Child, jobjWorlds, materials, mobjToMatIdx, tobjHashToFilename,
        positions, normals, uvs, vertColors, vertMatIdx, facesByMat, seen);
    WalkAndEmit(jobj.Next, jobjWorlds, materials, mobjToMatIdx, tobjHashToFilename,
        positions, normals, uvs, vertColors, vertMatIdx, facesByMat, seen);
}

static Vector3 MaterialDiffuseFallback(MaterialEntry e) =>
    new Vector3(e.DifR / 255f, e.DifG / 255f, e.DifB / 255f);

static void EmitPobj(
    HSD_POBJ pobj,
    HSD_JOBJ parent,
    Matrix4x4 parentTransform,
    Dictionary<int, Matrix4x4> jobjWorlds,
    MaterialEntry matEntry,
    int matIdx,
    List<Vector3> positions,
    List<Vector3> normals,
    List<Vector2> uvs,
    List<Vector3> vertColors,
    List<int> vertMatIdx,
    List<(int v, int n, int t)[]> faces)
{
    var dl = pobj.ToDisplayList();
    var allVerts = GX_VertexAccessor.GetDecodedVertices(dl, pobj);
    var envelopes = pobj.EnvelopeWeights;
    bool hasPNMTXIDX = pobj.HasAttribute(GXAttribName.GX_VA_PNMTXIDX);
    if (Environment.GetEnvironmentVariable("THE_SHOP_HSD_LOG_ENV") == "1")
    {
        int envCount = envelopes?.Length ?? -1;
        int multiBone = 0;
        int singleBone = 0;
        if (envelopes != null)
        {
            for (int i = 0; i < envelopes.Length; i++)
            {
                var en = envelopes[i];
                if (en == null) continue;
                if (en.EnvelopeCount > 1) multiBone++;
                else if (en.EnvelopeCount == 1) singleBone++;
            }
        }
        Console.Error.WriteLine($"  pobj envelopes={envCount} single={singleBone} multi={multiBone} hasPNMTXIDX={hasPNMTXIDX}");
    }
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
            else if (mode == "bind-skin")
            {
                // Proper bind-pose multi-bone skinning. At bind pose,
                // world_bind * inverse_bind = identity for each bone, so
                // sum(weight * (world * inv_bind * pos)) reduces to pos.
                // Envelope verts pass through; non-envelope go through
                // parent's world matrix (rigid bind to parent JOBJ).
                if (!hasPNMTXIDX)
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
            var rawUv = new Vector2(gv.TEX0.X, gv.TEX0.Y);
            uvs.Add(TransformUV(rawUv, matEntry));
            vertColors.Add(MaterialDiffuseFallback(matEntry));
            vertMatIdx.Add(matIdx);
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

static int GetOrAddMaterial(
    HSD_MOBJ? mobj,
    Dictionary<int, int> mobjToMatIdx,
    List<MaterialEntry> materials,
    Dictionary<int, string> tobjHashToFilename)
{
    int hash = mobj == null ? 0 : System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(mobj);
    if (mobjToMatIdx.TryGetValue(hash, out var existing))
        return existing;

    var entry = new MaterialEntry { Name = $"mat_{materials.Count:D3}" };
    var mat = mobj?.Material;
    if (mat != null)
    {
        entry.AmbR = mat.AMB_R; entry.AmbG = mat.AMB_G; entry.AmbB = mat.AMB_B; entry.AmbA = mat.AMB_A;
        entry.DifR = mat.DIF_R; entry.DifG = mat.DIF_G; entry.DifB = mat.DIF_B; entry.DifA = mat.DIF_A;
        entry.SpcR = mat.SPC_R; entry.SpcG = mat.SPC_G; entry.SpcB = mat.SPC_B; entry.SpcA = mat.SPC_A;
        entry.Shininess = mat.Shininess;
        entry.Alpha = mat.Alpha;
    }
    else
    {
        entry.AmbR = entry.AmbG = entry.AmbB = 217;
        entry.DifR = entry.DifG = entry.DifB = 217;
        entry.SpcR = entry.SpcG = entry.SpcB = 0;
        entry.AmbA = entry.DifA = entry.SpcA = 255;
        entry.Alpha = 1.0f;
        entry.Shininess = 50f;
    }

    if (mobj?.Textures != null)
    {
        HSD_TOBJ? primary = null;
        HSD_TOBJ? fallback = null;
        var t = mobj.Textures;
        while (t != null)
        {
            if (t.ImageData != null)
            {
                if (t.DiffuseLightmap && primary == null) primary = t;
                if (fallback == null) fallback = t;
            }
            t = t.Next;
        }
        var chosen = primary ?? fallback;
        if (chosen != null)
        {
            entry.DiffuseTobj = chosen;
            entry.DiffuseFromFallback = primary == null;
            entry.UvSX = chosen.SX; entry.UvSY = chosen.SY; entry.UvSZ = chosen.SZ;
            entry.UvRX = chosen.RX; entry.UvRY = chosen.RY; entry.UvRZ = chosen.RZ;
            entry.UvTX = chosen.TX; entry.UvTY = chosen.TY; entry.UvTZ = chosen.TZ;
            var imgBytes = chosen.ImageData?.ImageData;
            int thash = imgBytes != null
                ? System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(imgBytes)
                : System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(chosen);
            if (!tobjHashToFilename.TryGetValue(thash, out var existingFile))
            {
                existingFile = $"tex_{tobjHashToFilename.Count:D3}.png";
                tobjHashToFilename[thash] = existingFile;
            }
            entry.TexFilename = existingFile;
        }
    }

    int idx = materials.Count;
    materials.Add(entry);
    mobjToMatIdx[hash] = idx;
    return idx;
}

static Vector2 TransformUV(Vector2 uv, MaterialEntry entry)
{
    if (entry.DiffuseTobj == null) return uv;
    if (Environment.GetEnvironmentVariable("THE_SHOP_HSD_SKIP_UVXFORM") == "1") return uv;
    var s = Matrix4x4.CreateScale(entry.UvSX, entry.UvSY, entry.UvSZ);
    var r = EulerMatrix(entry.UvRX, entry.UvRY, entry.UvRZ);
    var t = Matrix4x4.CreateTranslation(entry.UvTX, entry.UvTY, entry.UvTZ);
    var m = s * r * t;
    if (!Matrix4x4.Invert(m, out var inv)) return uv;
    var v = Vector3.Transform(new Vector3(uv.X, uv.Y, 0), inv);
    return new Vector2(v.X, v.Y);
}

static void WriteMtl(string path, List<MaterialEntry> materials)
{
    using var w = new StreamWriter(path);
    w.WriteLine("# the-shop-hsd MTL export");
    foreach (var e in materials)
    {
        w.WriteLine($"newmtl {e.Name}");
        w.WriteLine($"Ka {F(e.AmbR / 255f)} {F(e.AmbG / 255f)} {F(e.AmbB / 255f)}");
        w.WriteLine($"Kd {F(e.DifR / 255f)} {F(e.DifG / 255f)} {F(e.DifB / 255f)}");
        w.WriteLine($"Ks {F(e.SpcR / 255f)} {F(e.SpcG / 255f)} {F(e.SpcB / 255f)}");
        w.WriteLine($"Ns {F(MathF.Max(0.001f, e.Shininess))}");
        w.WriteLine($"d {F(MathF.Max(0f, MathF.Min(1f, e.Alpha)))}");
        w.WriteLine("illum 2");
        if (e.TexFilename != null)
            w.WriteLine($"map_Kd {e.TexFilename}");
        w.WriteLine();
    }
}

static int ExportMaterialTextures(List<MaterialEntry> materials, string outDir)
{
    int written = 0;
    var writtenFiles = new HashSet<string>();
    foreach (var e in materials)
    {
        if (e.DiffuseTobj == null || e.TexFilename == null) continue;
        if (!writtenFiles.Add(e.TexFilename)) continue;
        var path = Path.Combine(outDir, e.TexFilename);
        if (SaveTextureAsPng(e.DiffuseTobj, path) == 0)
            written++;
    }
    return written;
}

static void LogMaterials(List<MaterialEntry> materials)
{
    Console.Error.WriteLine($"--- materials ({materials.Count}) ---");
    foreach (var e in materials)
    {
        var has = e.DiffuseTobj != null ? (e.DiffuseFromFallback ? "diffuse(fallback)" : "diffuse") : "untextured";
        Console.Error.WriteLine(
            $"  {e.Name} {has} Kd=({e.DifR},{e.DifG},{e.DifB}) " +
            $"R=({F(e.UvRX)},{F(e.UvRY)},{F(e.UvRZ)}) " +
            $"S=({F(e.UvSX)},{F(e.UvSY)},{F(e.UvSZ)}) " +
            $"T=({F(e.UvTX)},{F(e.UvTY)},{F(e.UvTZ)})");
    }
}

static int ToGltf(string[] args)
{
    if (args.Length < 3) return Usage();
    var input = args[1];
    var output = args[2];

    var file = new HSDRawFile(input);
    var positions = new List<Vector3>();
    var normals = new List<Vector3>();
    var uvs = new List<Vector2>();
    var vertColors = new List<Vector3>();
    var vertMatIdx = new List<int>();
    var facesByMat = new Dictionary<int, List<(int v, int n, int t)[]>>();
    var materials = new List<MaterialEntry>();
    var mobjToMatIdx = new Dictionary<int, int>();
    var tobjHashToFilename = new Dictionary<int, string>();

    var jobjWorlds = new Dictionary<int, Matrix4x4>();
    foreach (var root in file.Roots)
        if (root.Data is HSD_JOBJ rj) BuildJobjWorlds(rj, Matrix4x4.Identity, jobjWorlds, new HashSet<int>());
    foreach (var root in file.Roots)
        if (root.Data is HSD_JOBJ rj) WalkAndEmit(rj, jobjWorlds, materials, mobjToMatIdx, tobjHashToFilename,
            positions, normals, uvs, vertColors, vertMatIdx, facesByMat, new HashSet<int>());

    // Build one MaterialBuilder per MaterialEntry. Textures are embedded as PNGs
    // inside the GLB binary buffer.
    var matBuilders = new Dictionary<int, MaterialBuilder>();
    var texBytesByFilename = new Dictionary<string, byte[]>();
    foreach (var (matIdx, _) in facesByMat)
    {
        var e = materials[matIdx];
        var builder = new MaterialBuilder(e.Name).WithDoubleSide(true);
        if (e.DiffuseTobj != null && e.TexFilename != null)
        {
            if (!texBytesByFilename.TryGetValue(e.TexFilename, out var pngBytes))
            {
                pngBytes = EncodeTobjAsPngBytes(e.DiffuseTobj);
                texBytesByFilename[e.TexFilename] = pngBytes;
            }
            var img = new SharpGLTF.Memory.MemoryImage(pngBytes);
            builder.WithBaseColor(img);
        }
        else
        {
            builder.WithBaseColor(new Vector4(e.DifR / 255f, e.DifG / 255f, e.DifB / 255f, e.Alpha));
        }
        matBuilders[matIdx] = builder;
    }

    // Build a single MeshBuilder with one primitive per material. Each primitive
    // is keyed on its MaterialBuilder; SharpGLTF dedupes vertices within a primitive.
    var mesh = new MeshBuilder<VertexPositionNormal, VertexTexture1>("character");
    foreach (var (matIdx, bucket) in facesByMat)
    {
        if (bucket.Count == 0) continue;
        var prim = mesh.UsePrimitive(matBuilders[matIdx]);
        foreach (var face in bucket)
        {
            if (face.Length < 3) continue;
            var v0 = MakeVertex(face[0].v, face[0].n, face[0].t, positions, normals, uvs);
            var v1 = MakeVertex(face[1].v, face[1].n, face[1].t, positions, normals, uvs);
            var v2 = MakeVertex(face[2].v, face[2].n, face[2].t, positions, normals, uvs);
            prim.AddTriangle(v0, v1, v2);
        }
    }

    var scene = new SceneBuilder();
    scene.AddRigidMesh(mesh, Matrix4x4.Identity);
    var model = scene.ToGltf2();

    Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(output)) ?? ".");
    model.SaveGLB(output);

    int totalFaces = 0;
    foreach (var b in facesByMat.Values) totalFaces += b.Count;
    Console.WriteLine($"wrote {positions.Count} verts, {totalFaces} faces, {materials.Count} mats, {texBytesByFilename.Count} textures to {output}");
    return totalFaces > 0 ? 0 : 4;
}

static byte[] EncodeTobjAsPngBytes(HSD_TOBJ tobj)
{
    var rgba = tobj.GetDecodedImageData();
    int w = tobj.ImageData!.Width;
    int h = tobj.ImageData!.Height;
    using var image = Image.LoadPixelData<Bgra32>(rgba.AsSpan(0, w * h * 4), w, h);
    using var ms = new MemoryStream();
    image.SaveAsPng(ms);
    return ms.ToArray();
}

static VertexBuilder<VertexPositionNormal, VertexTexture1, VertexEmpty> MakeVertex(
    int vIdx, int nIdx, int tIdx,
    List<Vector3> positions, List<Vector3> normals, List<Vector2> uvs)
{
    var pos = vIdx >= 0 && vIdx < positions.Count ? positions[vIdx] : Vector3.Zero;
    var nrm = nIdx >= 0 && nIdx < normals.Count ? normals[nIdx] : Vector3.UnitY;
    var uv = tIdx >= 0 && tIdx < uvs.Count ? uvs[tIdx] : Vector2.Zero;
    return new VertexBuilder<VertexPositionNormal, VertexTexture1, VertexEmpty>(
        new VertexPositionNormal(pos, nrm),
        new VertexTexture1(uv));
}

class MaterialEntry
{
    public string Name = "mat";
    public byte AmbR, AmbG, AmbB, AmbA;
    public byte DifR, DifG, DifB, DifA;
    public byte SpcR, SpcG, SpcB, SpcA;
    public float Shininess = 50f;
    public float Alpha = 1.0f;
    public HSD_TOBJ? DiffuseTobj;
    public bool DiffuseFromFallback;
    public string? TexFilename;
    public float UvSX = 1, UvSY = 1, UvSZ = 1;
    public float UvRX, UvRY, UvRZ;
    public float UvTX, UvTY, UvTZ;
    public bool HasDiffuseTexture => DiffuseTobj != null && TexFilename != null;
}
