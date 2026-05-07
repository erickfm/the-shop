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
using HSDRaw.Common.Animation;
using HSDRaw.Tools;
using HSDRaw.Melee.Pl;

if (args.Length < 1)
{
    Console.Error.WriteLine("usage: the-shop-hsd <identify|inspect|thumbnail|dump-textures|to-obj|to-gltf|validate-costume|validate-stage> ...");
    return 2;
}

return args[0] switch
{
    "identify" => Identify(args),
    "inspect" => Inspect(args),
    "dump-materials" => DumpMaterials(args),
    "thumbnail" => Thumbnail(args),
    "dump-textures" => DumpTextures(args),
    "to-obj" => ToObj(args),
    "to-gltf" => ToGltf(args),
    "validate-costume" => ValidateCostume(args),
    "validate-stage" => ValidateStage(args),
    "detect-mex" => DetectMex(args),
    _ => Usage(),
};

// Probe a .usd (typically MnSlChr.usd or IfAll.usd) for m-ex's restructured
// symbols. If `mexSelectChr` exists in MnSlChr.usd, the user has m-ex applied
// for CSPs; if `Stc_icns` exists in IfAll.usd, m-ex is applied for stock icons.
// Either symbol present = m-ex DOL patches are active.
//
// Emits one JSON line: {"file":"...","mex_select_chr":bool,"stc_icns":bool,
//                       "csp_stride":int|null, "stock_stride":int|null,
//                       "csp_count":int|null, "stock_count":int|null,
//                       "roots":[...]}
static int DetectMex(string[] args)
{
    if (args.Length < 2) return Usage();
    var path = args[1];
    HSDRawFile file;
    try { file = new HSDRawFile(path); }
    catch (Exception e)
    {
        Console.Error.WriteLine($"detect-mex failed to open: {e.Message}");
        return 3;
    }

    bool hasMexSelectChr = false;
    bool hasStcIcns = false;
    int? cspStride = null;
    int? stockStride = null;
    int? cspCount = null;
    int? stockCount = null;
    var rootNames = new List<string>();

    foreach (var r in file.Roots)
    {
        rootNames.Add(r.Name ?? "");
        if (r.Name == "mexSelectChr" && r.Data is HSDRaw.MEX.Menus.MEX_mexSelectChr msc)
        {
            hasMexSelectChr = true;
            cspStride = msc.CSPStride;
            try
            {
                var keys = msc.CSPMatAnim?.TextureAnimation?.AnimationObject?.FObjDesc?.GetDecodedKeys();
                if (keys != null) cspCount = keys.Count;
            }
            catch { }
        }
        if (r.Name == "Stc_icns" && r.Data is HSDRaw.MEX.MEX_Stock stc)
        {
            hasStcIcns = true;
            stockStride = stc.Stride;
            try
            {
                var keys = stc.MatAnimJoint?.MaterialAnimation?.TextureAnimation?.AnimationObject?.FObjDesc?.GetDecodedKeys();
                if (keys != null) stockCount = keys.Count;
            }
            catch { }
        }
    }

    var sb = new System.Text.StringBuilder();
    sb.Append("{\"file\":\"").Append(JsonEscape(path)).Append('"');
    sb.Append(",\"mex_select_chr\":").Append(hasMexSelectChr ? "true" : "false");
    sb.Append(",\"stc_icns\":").Append(hasStcIcns ? "true" : "false");
    sb.Append(",\"csp_stride\":").Append(cspStride.HasValue ? cspStride.Value.ToString() : "null");
    sb.Append(",\"stock_stride\":").Append(stockStride.HasValue ? stockStride.Value.ToString() : "null");
    sb.Append(",\"csp_count\":").Append(cspCount.HasValue ? cspCount.Value.ToString() : "null");
    sb.Append(",\"stock_count\":").Append(stockCount.HasValue ? stockCount.Value.ToString() : "null");
    sb.Append(",\"roots\":[");
    for (int i = 0; i < rootNames.Count; i++)
    {
        if (i > 0) sb.Append(',');
        sb.Append('"').Append(JsonEscape(rootNames[i])).Append('"');
    }
    sb.Append("]}");
    Console.WriteLine(sb.ToString());
    return 0;
}

// One-off diagnostic. For each DObj/MOBJ in the file, print the TOBJ list with
// flags + sizes so we can see what we're picking vs. what's actually in the file.
static int DumpMaterials(string[] args)
{
    if (args.Length < 2) return Usage();
    var file = new HSDRawFile(args[1]);
    int matIdx = 0;
    foreach (var root in file.Roots)
    {
        if (root.Data is not HSD_JOBJ rj) continue;
        foreach (var jobj in rj.TreeList)
        {
            var dobj = jobj.Dobj;
            int dObjIdx = 0;
            while (dobj != null)
            {
                var mobj = dobj.Mobj;
                int tobjCount = 0;
                var tobjs = new List<HSD_TOBJ>();
                var t = mobj?.Textures;
                while (t != null) { tobjs.Add(t); tobjCount++; t = t.Next; }
                var rf = mobj?.RenderFlags ?? 0;
                Console.WriteLine($"mat[{matIdx:D3}] dobj[{dObjIdx}] tobjs={tobjCount} dif=({mobj?.Material?.DIF_R},{mobj?.Material?.DIF_G},{mobj?.Material?.DIF_B}) amb=({mobj?.Material?.AMB_R},{mobj?.Material?.AMB_G},{mobj?.Material?.AMB_B}) alpha={(mobj?.Material?.Alpha ?? 1f):F2} renderFlags=0x{(int)rf:x8} [DIF={rf.HasFlag(HSDRaw.Common.RENDER_MODE.DIFFUSE)} CONST={rf.HasFlag(HSDRaw.Common.RENDER_MODE.CONSTANT)} XLU={rf.HasFlag(HSDRaw.Common.RENDER_MODE.XLU)}]");
                for (int i = 0; i < tobjs.Count; i++)
                {
                    var tt = tobjs[i];
                    var img = tt.ImageData;
                    Console.WriteLine($"    tobj[{i}] flags=0x{(int)tt.Flags:x8} dif={tt.DiffuseLightmap} coord={tt.CoordType} colorOp={tt.ColorOperation} alphaOp={tt.AlphaOperation} blend={tt.Blending:F2} size={(img?.Width ?? 0)}x{(img?.Height ?? 0)} fmt={(img?.Format.ToString() ?? "null")}");
                }
                matIdx++;
                dObjIdx++;
                dobj = dobj.Next;
            }
        }
    }
    return 0;
}

static int Usage()
{
    Console.Error.WriteLine("commands:");
    Console.Error.WriteLine("  identify <input.dat>             (emits JSON to stdout)");
    Console.Error.WriteLine("  inspect <input.dat>");
    Console.Error.WriteLine("  thumbnail <input.dat> <output.png>");
    Console.Error.WriteLine("  dump-textures <input.dat> <output_dir>");
    Console.Error.WriteLine("  to-obj <input.dat> <output.obj>");
    Console.Error.WriteLine("  to-gltf <input.dat> <output.glb>");
    return 2;
}

// Emit a single-line JSON describing what kind of HAL .dat this is and which
// character it belongs to. Slot is intentionally NOT included — it lives on the
// disk, not in the file.
//
// Schema: {"kind":"costume|fighter_data|common_data|effect|stage|unknown",
//          "character_internal":"Fox"|null, "root_names":[...]}
static int Identify(string[] args)
{
    if (args.Length < 2) return Usage();
    var path = args[1];
    HSDRawFile file;
    try { file = new HSDRawFile(path); }
    catch (Exception e)
    {
        Console.Error.WriteLine($"identify failed to open: {e.Message}");
        return 3;
    }
    string kind = "unknown";
    string? characterInternal = null;
    var rootNames = new List<string>();
    foreach (var r in file.Roots) rootNames.Add(r.Name ?? "");

    foreach (var name in rootNames)
    {
        // Costume skin. Format is Ply<Name><Tier>K[<Slot>]_Share_joint, e.g.:
        //   PlyFox5K_Share_joint           (Fox, default slot)
        //   PlyFox5KBu_Share_joint         (Fox, "Bu" slot variant)
        //   PlyFalco5KGr_Share_joint       (Falco, "Gr" slot variant)
        //   PlyGamewatch5K_Share_joint     (G&W, default slot)
        // The character name is everything up to (but not including) the first digit.
        if (name.StartsWith("Ply") && name.Contains("Share_joint"))
        {
            kind = "costume";
            int start = 3;
            int end = name.IndexOf("Share_joint");
            if (end > start)
            {
                var middle = name.Substring(start, end - start).TrimEnd('_');
                int firstDigit = -1;
                for (int i = 0; i < middle.Length; i++)
                {
                    if (char.IsDigit(middle[i])) { firstDigit = i; break; }
                }
                characterInternal = firstDigit > 0 ? middle.Substring(0, firstDigit) : middle;
            }
            break;
        }
        // Fighter data (per-character common file like PlGw.dat, PlFx.dat): ftDataGamewatch, ftDataFox
        if (name.StartsWith("ftData"))
        {
            kind = "fighter_data";
            characterInternal = name.Substring("ftData".Length);
            break;
        }
        // Common load data (PlCo.dat)
        if (name == "ftLoadCommonData" || name.StartsWith("ftLoadCommon"))
        {
            kind = "common_data";
            break;
        }
        // Effect file (EfFxData.dat etc): effFoxDataTable
        if (name.StartsWith("eff") && name.EndsWith("DataTable"))
        {
            kind = "effect";
            int start = 3;
            int end = name.Length - "DataTable".Length;
            if (end > start) characterInternal = name.Substring(start, end - start);
            break;
        }
        // Stage data: roots typically begin with "Grd", "ALD", "map_", or contain "_image"
        if (name.StartsWith("Grd") || name.StartsWith("ALD") || name.StartsWith("map_"))
        {
            kind = "stage";
            break;
        }
    }

    // JSON emission — manual to avoid pulling System.Text.Json into the trim graph.
    var sb = new System.Text.StringBuilder();
    sb.Append("{\"kind\":\"").Append(kind).Append('"');
    sb.Append(",\"character_internal\":");
    if (characterInternal == null) sb.Append("null");
    else sb.Append('"').Append(JsonEscape(characterInternal)).Append('"');
    sb.Append(",\"root_names\":[");
    for (int i = 0; i < rootNames.Count; i++)
    {
        if (i > 0) sb.Append(',');
        sb.Append('"').Append(JsonEscape(rootNames[i])).Append('"');
    }
    sb.Append("]}");
    Console.WriteLine(sb.ToString());
    return 0;
}

static string JsonEscape(string s)
{
    var sb = new System.Text.StringBuilder(s.Length);
    foreach (var c in s)
    {
        switch (c)
        {
            case '\\': sb.Append("\\\\"); break;
            case '"': sb.Append("\\\""); break;
            case '\n': sb.Append("\\n"); break;
            case '\r': sb.Append("\\r"); break;
            case '\t': sb.Append("\\t"); break;
            default:
                if (c < 0x20) sb.AppendFormat("\\u{0:x4}", (int)c);
                else sb.Append(c);
                break;
        }
    }
    return sb.ToString();
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
    var invBindCache = new Dictionary<int, Matrix4x4>();
    foreach (var root in file.Roots)
    {
        if (root.Data is HSD_JOBJ rootJobj)
        {
            BuildJobjWorlds(rootJobj, Matrix4x4.Identity, jobjWorlds, new HashSet<int>());
        }
    }

    var emptyLowPoly = new Dictionary<int, HashSet<int>>();
    foreach (var root in file.Roots)
    {
        if (root.Data is HSD_JOBJ rootJobj)
        {
            WalkAndEmit(
                rootJobj, jobjWorlds, invBindCache,
                materials, mobjToMatIdx, tobjHashToFilename,
                emptyLowPoly,
                false,
                positions, normals, uvs, vertColors, vertMatIdx,
                facesByMat);
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
    int hash = jobj.GetHashCode();
    if (!seen.Add(hash)) return;

    var world = LocalMatrix(jobj) * parentWorld;
    map[hash] = world;

    BuildJobjWorlds(jobj.Child, world, map, seen);
    BuildJobjWorlds(jobj.Next, parentWorld, map, seen);
}

static Matrix4x4 GetWorld(HSD_JOBJ? j, Dictionary<int, Matrix4x4> jobjWorlds)
{
    if (j == null) return Matrix4x4.Identity;
    int h = j.GetHashCode();
    return jobjWorlds.TryGetValue(h, out var m) ? m : Matrix4x4.Identity;
}

static Matrix4x4 HsdToNumerics(HSDRaw.Common.HSD_Matrix4x3 mat)
{
    // HSDLib stores 4x3 matrices row-major (M[r,c]); System.Numerics.Matrix4x4
    // expects last row as translation. Construct so that Vector3.Transform(v, m)
    // gives the same result HSDRawViewer's IO/ModelExporter does.
    return new Matrix4x4(
        mat.M11, mat.M21, mat.M31, 0,
        mat.M12, mat.M22, mat.M32, 0,
        mat.M13, mat.M23, mat.M33, 0,
        mat.M14, mat.M24, mat.M34, 1);
}

static Matrix4x4 GetInverseBind(HSD_JOBJ? j, Dictionary<int, Matrix4x4> cache)
{
    if (j == null) return Matrix4x4.Identity;
    int h = j.GetHashCode();
    if (cache.TryGetValue(h, out var m)) return m;
    return Matrix4x4.Identity;
}

// transpose(inverse(m)) — the canonical normal matrix. Required for normals to
// stay perpendicular to the surface under non-uniform scale or shear; reduces
// to the rotation submatrix for pure rotation+translation.
static Matrix4x4 NormalMatrix(Matrix4x4 m)
{
    if (!Matrix4x4.Invert(m, out var inv)) return m;
    return Matrix4x4.Transpose(inv);
}

static void WalkAndEmit(
    HSD_JOBJ? rootJobj,
    Dictionary<int, Matrix4x4> jobjWorlds,
    Dictionary<int, Matrix4x4> invBindCache,
    List<MaterialEntry> materials,
    Dictionary<int, int> mobjToMatIdx,
    Dictionary<int, string> tobjHashToFilename,
    Dictionary<int, HashSet<int>> lowPolyDObjsByJObj,
    bool noTextures,
    List<Vector3> positions,
    List<Vector3> normals,
    List<Vector2> uvs,
    List<Vector3> vertColors,
    List<int> vertMatIdx,
    Dictionary<int, List<(int v, int n, int t)[]>> facesByMat)
{
    if (rootJobj == null) return;

    bool skipEnvelope = Environment.GetEnvironmentVariable("THE_SHOP_HSD_SKIP_ENVELOPE") == "1";
    int hidden = 0;

    // Iterate via TreeList so jObjIdx aligns with the fighter-data lookup keys.
    var jobjs = rootJobj.TreeList;
    for (int jObjIdx = 0; jObjIdx < jobjs.Count; jObjIdx++)
    {
        var jobj = jobjs[jObjIdx];
        var parentTransform = GetWorld(jobj, jobjWorlds);
        lowPolyDObjsByJObj.TryGetValue(jObjIdx, out var lowPolySet);

        int dObjIdx = 0;
        var dobj = jobj.Dobj;
        while (dobj != null)
        {
            if (lowPolySet != null && lowPolySet.Contains(dObjIdx))
            {
                hidden++;
                dObjIdx++;
                dobj = dobj.Next;
                continue;
            }

            var matIdx = GetOrAddMaterial(dobj.Mobj, mobjToMatIdx, materials, tobjHashToFilename, noTextures);
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
                try
                {
                    EmitPobj(pobj, jobj, parentTransform, jobjWorlds, invBindCache, matEntry, matIdx,
                        positions, normals, uvs, vertColors, vertMatIdx, faceBucket);
                }
                catch (Exception e)
                {
                    Console.Error.WriteLine($"skipping POBJ: {e.Message}");
                }
                pobj = pobj.Next;
            }
            dObjIdx++;
            dobj = dobj.Next;
        }
    }

    if (Environment.GetEnvironmentVariable("THE_SHOP_HSD_LOG_LOWPOLY") == "1")
        Console.Error.WriteLine($"WalkAndEmit: hid {hidden} low-poly DObjs");
}

static Vector3 MaterialDiffuseFallback(MaterialEntry e) =>
    new Vector3(e.DifR / 255f, e.DifG / 255f, e.DifB / 255f);

static void EmitPobj(
    HSD_POBJ pobj,
    HSD_JOBJ parent,
    Matrix4x4 parentTransform,
    Dictionary<int, Matrix4x4> jobjWorlds,
    Dictionary<int, Matrix4x4> invBindCache,
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
    bool hasClr0 = pobj.HasAttribute(GXAttribName.GX_VA_CLR0);
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
            var localPos = new Vector3(gv.POS.X, gv.POS.Y, gv.POS.Z);
            var localNrm = new Vector3(gv.NRM.X, gv.NRM.Y, gv.NRM.Z);

            // Skinning matches HSDRawViewer's Shader/gx.vert main() (lines 115-156):
            //   - single-bone weight=1: vec * world[bone]   (bone-local stored vertex)
            //   - multi-bone weighted:  sum(w * vec * inv_bind[bone] * world[bone])
            //                                              (mesh-local stored vertex)
            // No normalization by sum-of-weights; HAL data has weights summing to 1,
            // the canonical shader doesn't divide either.
            if (hasPNMTXIDX && envelopes != null)
            {
                SkinStats.Total++;
                int eIdx = gv.PNMTXIDX / 3;
                if (eIdx >= 0 && eIdx < envelopes.Length)
                {
                    var en = envelopes[eIdx];
                    bool singleBindOpt = en.EnvelopeCount > 0
                        && en.GetWeightAt(0) == 1.0f
                        && en.GetJOBJAt(0) != null;
                    if (singleBindOpt)
                    {
                        var bone = en.GetJOBJAt(0)!;
                        var world = GetWorld(bone, jobjWorlds);
                        localPos = Vector3.Transform(localPos, world);
                        // Use HAL's authored vertex normal as-is (no skinning
                        // transform). Set THE_SHOP_HSD_TRANSFORM_NORMALS=1 to
                        // re-enable the canonical normal-matrix skinning.
                        if (Environment.GetEnvironmentVariable("THE_SHOP_HSD_TRANSFORM_NORMALS") == "1")
                            localNrm = Vector3.TransformNormal(localNrm, NormalMatrix(world));
                    }
                    else
                    {
                        Vector3 accumPos = Vector3.Zero;
                        Vector3 accumNrm = Vector3.Zero;
                        int nullCount = 0;
                        int contributingCount = 0;
                        for (int wi = 0; wi < en.EnvelopeCount; wi++)
                        {
                            var bone = en.GetJOBJAt(wi);
                            float w = en.GetWeightAt(wi);
                            if (bone == null) { nullCount++; continue; }
                            if (w <= 0) continue;
                            var world = GetWorld(bone, jobjWorlds);
                            var invBind = GetInverseBind(bone, invBindCache);
                            var skinM = invBind * world;
                            accumPos += w * Vector3.Transform(localPos, skinM);
                            if (Environment.GetEnvironmentVariable("THE_SHOP_HSD_TRANSFORM_NORMALS") == "1")
                                accumNrm += w * Vector3.TransformNormal(localNrm, NormalMatrix(skinM));
                            else
                                accumNrm += w * localNrm;
                            contributingCount++;
                        }
                        if (en.EnvelopeCount > 0 && nullCount == en.EnvelopeCount)
                        {
                            SkinStats.AllBonesNull++;
                            SkinStats.Sample($"allBonesNull eIdx={eIdx} envCount={en.EnvelopeCount}");
                        }
                        else if (nullCount > 0)
                        {
                            SkinStats.PartialBonesNull++;
                        }
                        if (contributingCount > 0)
                        {
                            localPos = accumPos;
                            localNrm = accumNrm;
                        }
                        else
                        {
                            SkinStats.TotalWZero++;
                            SkinStats.Sample($"totalWZero eIdx={eIdx} envCount={en.EnvelopeCount} nullCount={nullCount}");
                        }
                    }
                }
                else
                {
                    SkinStats.EIdxOob++;
                    SkinStats.Sample($"eIdxOOB PNMTXIDX={gv.PNMTXIDX} eIdx={eIdx} envLen={envelopes.Length}");
                }
            }
            else if (hasPNMTXIDX)
            {
                SkinStats.Total++;
                SkinStats.NoEnvelopeArr++;
            }
            else
            {
                // non-envelope: rigid bind to parent JOBJ
                localPos = Vector3.Transform(localPos, parentTransform);
                localNrm = Vector3.TransformNormal(localNrm, NormalMatrix(parentTransform));
            }
            localPos = Vector3.Transform(localPos, singleBindTransform);
            localNrm = Vector3.TransformNormal(localNrm, NormalMatrix(singleBindTransform));

            if (localNrm.LengthSquared() > 1e-12f)
                localNrm = Vector3.Normalize(localNrm);

            positions.Add(localPos);
            normals.Add(localNrm);
            var rawUv = new Vector2(gv.TEX0.X, gv.TEX0.Y);
            uvs.Add(TransformUV(rawUv, matEntry));
            // Vertex color emission is gated on whether the material has a
            // texture. For TEXTURED materials we always push white — CLR0 in
            // the file is part of a GX TEV combine we can't reproduce, and
            // multiplying it naively (e.g. CLR0=(0,0,0)) turns surfaces fully
            // black even when in-game they render normally. For UNTEXTURED
            // materials we push the real CLR0 because it IS the surface color
            // there. Without per-vertex color, untextured surfaces fall back
            // to the material's flat MOBJ.diffuse base color.
            bool matIsTextured = matEntry.HasDiffuseTexture;
            if (hasClr0 && !matIsTextured)
                vertColors.Add(new Vector3(gv.CLR0.R, gv.CLR0.G, gv.CLR0.B));
            else
                vertColors.Add(new Vector3(1f, 1f, 1f));
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

static void CollectLookup(
    HSDRaw.HSDArrayAccessor<HSDRaw.Melee.Pl.SBM_LookupTable>? root,
    Dictionary<int, HashSet<int>> outDict)
{
    if (root == null) return;
    foreach (var table in root.Array)
    {
        if (table.LookupEntries == null) continue;
        int jObjIdx = 0;
        foreach (var entry in table.LookupEntries.Array)
        {
            if (entry.Entries != null)
            {
                if (!outDict.ContainsKey(jObjIdx))
                    outDict[jObjIdx] = new HashSet<int>();
                foreach (var b in entry.Entries) outDict[jObjIdx].Add(b);
            }
            jObjIdx++;
        }
    }
}

static int GetOrAddMaterial(
    HSD_MOBJ? mobj,
    Dictionary<int, int> mobjToMatIdx,
    List<MaterialEntry> materials,
    Dictionary<int, string> tobjHashToFilename,
    bool noTextures)
{
    int hash = mobj == null ? 0 : System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(mobj);
    if (mobjToMatIdx.TryGetValue(hash, out var existing))
        return existing;

    var entry = new MaterialEntry { Name = $"mat_{materials.Count:D3}", RenderFlags = mobj?.RenderFlags ?? 0 };
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

    if (!noTextures && mobj?.Textures != null)
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
            entry.TexColorOp = chosen.ColorOperation;
            entry.UvSX = chosen.SX; entry.UvSY = chosen.SY; entry.UvSZ = chosen.SZ;
            entry.UvRX = chosen.RX; entry.UvRY = chosen.RY; entry.UvRZ = chosen.RZ;
            entry.UvTX = chosen.TX; entry.UvTY = chosen.TY; entry.UvTZ = chosen.TZ;
            // Content-hash the *decoded* image bytes. Object-identity hashing
            // (RuntimeHelpers.GetHashCode on the byte[]) collapses distinct
            // textures of the same dimensions because HSDLib hands back shared
            // references — that's how SPOOKY-FALCO's 38 unique textures got
            // squashed to 2 in earlier builds. Dedupe still works for genuinely
            // identical content (e.g. shared head texture across slots).
            int thash;
            try
            {
                var decoded = chosen.GetDecodedImageData();
                thash = ContentHash32(decoded, chosen.ImageData?.Width ?? 0, chosen.ImageData?.Height ?? 0);
            }
            catch
            {
                thash = System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(chosen);
            }
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

    SkinStats.Reset();

    string? posePath = null;
    string? fighterPath = null;
    int animIndex = 0;
    float poseFrame = 0f;
    bool noTextures = false;
    for (int i = 3; i < args.Length; i++)
    {
        if (args[i] == "--pose" && i + 1 < args.Length) posePath = args[++i];
        else if (args[i] == "--fighter" && i + 1 < args.Length) fighterPath = args[++i];
        else if (args[i] == "--anim-index" && i + 1 < args.Length) int.TryParse(args[++i], out animIndex);
        else if (args[i] == "--pose-frame" && i + 1 < args.Length) float.TryParse(args[++i], System.Globalization.CultureInfo.InvariantCulture, out poseFrame);
        else if (args[i] == "--no-textures") noTextures = true;
    }

    var file = new HSDRawFile(input);

    // Read the fighter data file (Pl<CC>.dat) for low-poly DObj visibility info.
    // Each costume ships both high-poly and low-poly versions of certain meshes
    // (head, hands, feet); the game hides low-poly variants when rendering at
    // close range. Without this filter, both versions render overlapped and the
    // model looks duplicated/jagged (e.g. TAILS shows 6 hair tufts instead of 3).
    var lowPolyDObjsByJObj = new Dictionary<int, HashSet<int>>();
    var highPolyDObjsByJObj = new Dictionary<int, HashSet<int>>();
    bool disableLodFilter = Environment.GetEnvironmentVariable("THE_SHOP_HSD_DISABLE_LOD") == "1";
    if (!disableLodFilter && fighterPath != null && File.Exists(fighterPath))
    {
        try
        {
            var fighterFile = new HSDRawFile(fighterPath);
            SBM_FighterData? fighterData = null;
            foreach (var r in fighterFile.Roots)
            {
                if (r.Data is SBM_FighterData fd) { fighterData = fd; break; }
            }
            var costumes = fighterData?.ModelLookupTables?.CostumeVisibilityLookups;
            if (costumes != null && costumes.Array.Length > 0)
            {
                // Costume index 0 (Nr/neutral) — low-poly DObj layout is the same
                // across all costume variants of the same character.
                var costume = costumes.Array[0];
                CollectLookup(costume.LowPoly, lowPolyDObjsByJObj);
                CollectLookup(costume.HighPoly, highPolyDObjsByJObj);
            }
            if (Environment.GetEnvironmentVariable("THE_SHOP_HSD_LOG_LOWPOLY") == "1")
            {
                int totalLow = 0, totalHigh = 0;
                foreach (var s in lowPolyDObjsByJObj.Values) totalLow += s.Count;
                foreach (var s in highPolyDObjsByJObj.Values) totalHigh += s.Count;
                Console.Error.WriteLine($"loaded fighter data: {lowPolyDObjsByJObj.Count} jobjs with low-poly ({totalLow} total), {highPolyDObjsByJObj.Count} with high-poly ({totalHigh} total)");
            }
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"fighter data load failed (skipping LOD filter): {e.Message}");
        }
    }

    // No per-skin compat heuristic — apply the fighter-data LowPoly hide
    // unconditionally. Vanilla-shaped skins (TAILS, EVA UNITs) look correct;
    // heavily-modded skins that repurpose LowPoly slots for unique content
    // (e.g. TAILS-ANIMELEE) will show that content as missing. Use
    // THE_SHOP_HSD_DISABLE_LOD=1 to opt out for those specific cases.
    if (lowPolyDObjsByJObj.Count > 0)
    {
        // No-op block left for future per-skin handling; kept to preserve
        // the file structure around the dictionary.
    }

    // Compute bind-pose world inverses BEFORE applying any pose so we have
    // a true bind reference for skinning.
    var invBindCache = new Dictionary<int, Matrix4x4>();
    var bindWorlds = new Dictionary<int, Matrix4x4>();
    foreach (var root in file.Roots)
        if (root.Data is HSD_JOBJ rj) BuildJobjWorlds(rj, Matrix4x4.Identity, bindWorlds, new HashSet<int>());
    foreach (var kv in bindWorlds)
    {
        if (Matrix4x4.Invert(kv.Value, out var inv))
            invBindCache[kv.Key] = inv;
        else
            invBindCache[kv.Key] = Matrix4x4.Identity;
    }

    if (posePath != null)
    {
        try
        {
            var animFile = new HSDRawFile(posePath);
            ApplyFigaTreePose(file, animFile, animIndex, poseFrame);
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"pose load failed: {e.Message}");
        }
    }
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
        if (root.Data is HSD_JOBJ rj) WalkAndEmit(rj, jobjWorlds, invBindCache, materials, mobjToMatIdx, tobjHashToFilename,
            lowPolyDObjsByJObj,
            noTextures,
            positions, normals, uvs, vertColors, vertMatIdx, facesByMat);

    // Build one MaterialBuilder per MaterialEntry. Textures are embedded as PNGs
    // inside the GLB binary buffer.
    var matBuilders = new Dictionary<int, MaterialBuilder>();
    var texBytesByFilename = new Dictionary<string, byte[]>();
    foreach (var (matIdx, _) in facesByMat)
    {
        var e = materials[matIdx];
        var builder = new MaterialBuilder(e.Name).WithDoubleSide(true);
        bool textured = !noTextures && e.DiffuseTobj != null && e.TexFilename != null;
        // Apply MOBJ.diffuse as a base-color factor only when (a) the TOBJ's
        // GX TEV combine is MODULATE (texture × previous, so multiplying is
        // semantically correct), AND (b) the diffuse is actually different
        // from white. White (255,255,255) would be a no-op multiply on paper
        // but emitting an explicit base-color factor in glTF can still flip
        // three.js's alpha-mode detection — keep the simple WithBaseColor(img)
        // path for the common no-op case.
        bool diffuseIsWhiteOpaque = e.DifR == 255 && e.DifG == 255 && e.DifB == 255 && e.Alpha >= 0.999f;
        bool useDiffuseFactor = e.TexColorOp == HSDRaw.Common.COLORMAP.MODULATE && !diffuseIsWhiteOpaque;
        var diffuseFactor = new Vector4(e.DifR / 255f, e.DifG / 255f, e.DifB / 255f, e.Alpha);
        if (textured)
        {
            if (!texBytesByFilename.TryGetValue(e.TexFilename!, out var pngBytes))
            {
                pngBytes = EncodeTobjAsPngBytes(e.DiffuseTobj!);
                texBytesByFilename[e.TexFilename!] = pngBytes;
            }
            var img = new SharpGLTF.Memory.MemoryImage(pngBytes);
            // Only multiply texture by MOBJ.diffuse when MOBJ says GX should
            // use it as the modulator (RENDER_MODE.DIFFUSE). For CONSTANT-mode
            // materials, GX's TEV reads its constant color from a register
            // that's set up by HAL's TEV stage program — we can't reproduce
            // that source faithfully without parsing the TEV blob, so we just
            // pass the texture through. That matches in-game appearance for
            // skins like TAILS-ANIMELEE / SPOOKY-FALCO that use CONSTANT mode
            // and rely on the texture content alone.
            if (useDiffuseFactor)
                builder.WithBaseColor(img, diffuseFactor);
            else
                builder.WithBaseColor(img);
        }
        else
        {
            builder.WithBaseColor(diffuseFactor);
            // Untextured-only: MOBJ ambient as glTF emissive (always-on
            // additive brightness floor). Skipped for textured materials
            // because adding emissive on top of a texture washes it out.
            if (e.AmbR > 0 || e.AmbG > 0 || e.AmbB > 0)
            {
                builder.WithEmissive(new Vector3(e.AmbR / 255f, e.AmbG / 255f, e.AmbB / 255f) * 0.5f);
            }
        }
        matBuilders[matIdx] = builder;
    }

    // Build a single MeshBuilder with one primitive per material. Each primitive
    // is keyed on its MaterialBuilder; SharpGLTF dedupes vertices within a primitive.
    var mesh = new MeshBuilder<VertexPositionNormal, VertexColor1Texture1>("character");
    foreach (var (matIdx, bucket) in facesByMat)
    {
        if (bucket.Count == 0) continue;
        var prim = mesh.UsePrimitive(matBuilders[matIdx]);
        foreach (var face in bucket)
        {
            if (face.Length < 3) continue;
            var v0 = MakeVertex(face[0].v, face[0].n, face[0].t, positions, normals, uvs, vertColors);
            var v1 = MakeVertex(face[1].v, face[1].n, face[1].t, positions, normals, uvs, vertColors);
            var v2 = MakeVertex(face[2].v, face[2].n, face[2].t, positions, normals, uvs, vertColors);
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
    if (Environment.GetEnvironmentVariable("THE_SHOP_HSD_LOG_SPIKES") == "1")
        SkinStats.Print();
    return totalFaces > 0 ? 0 : 4;
}

// FNV-1a 32-bit. Cheap content hash used as a dedupe key for decoded image
// bytes; collisions just mean two distinct textures share a PNG file in the
// GLB, which is benign — same effect as our previous identity-hash dedupe but
// driven by content instead of memory address.
static int ContentHash32(byte[] data, int w, int h)
{
    unchecked
    {
        const uint OFFSET = 2166136261u;
        const uint PRIME = 16777619u;
        uint hash = OFFSET;
        hash = (hash ^ (uint)w) * PRIME;
        hash = (hash ^ (uint)h) * PRIME;
        for (int i = 0; i < data.Length; i++) hash = (hash ^ data[i]) * PRIME;
        return (int)hash;
    }
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

static VertexBuilder<VertexPositionNormal, VertexColor1Texture1, VertexEmpty> MakeVertex(
    int vIdx, int nIdx, int tIdx,
    List<Vector3> positions, List<Vector3> normals, List<Vector2> uvs,
    List<Vector3> vertColors)
{
    var pos = vIdx >= 0 && vIdx < positions.Count ? positions[vIdx] : Vector3.Zero;
    var nrm = nIdx >= 0 && nIdx < normals.Count ? normals[nIdx] : Vector3.UnitY;
    var uv = tIdx >= 0 && tIdx < uvs.Count ? uvs[tIdx] : Vector2.Zero;
    // vertColors is parallel to positions; if it's short or empty we fall back to white
    // (which acts as a no-op in the texture * vertex_color * base_color combine).
    var col = vIdx >= 0 && vIdx < vertColors.Count ? vertColors[vIdx] : new Vector3(1f, 1f, 1f);
    return new VertexBuilder<VertexPositionNormal, VertexColor1Texture1, VertexEmpty>(
        new VertexPositionNormal(pos, nrm),
        new VertexColor1Texture1(new Vector4(col.X, col.Y, col.Z, 1f), uv));
}

static void ApplyFigaTreePose(HSDRawFile costume, HSDRawFile anim, int animIndex, float frame)
{
    if (animIndex < 0 || animIndex >= anim.Roots.Count) return;
    if (anim.Roots[animIndex].Data is not HSD_FigaTree tree) return;

    HSD_JOBJ? root = null;
    foreach (var r in costume.Roots)
        if (r.Data is HSD_JOBJ j) { root = j; break; }
    if (root == null) return;

    var jobjs = root.TreeList;
    var nodes = tree.Nodes;
    int count = Math.Min(nodes.Count, jobjs.Count);
    int applied = 0;
    int changed = 0;
    for (int i = 0; i < count; i++)
    {
        var jobj = jobjs[i];
        foreach (var track in nodes[i].Tracks)
        {
            float v = new FOBJ_Player(track.ToFOBJ()).GetValue(frame);
            float old = 0;
            bool matched = true;
            switch (track.JointTrackType)
            {
                case JointTrackType.HSD_A_J_ROTX: old = jobj.RX; jobj.RX = v; break;
                case JointTrackType.HSD_A_J_ROTY: old = jobj.RY; jobj.RY = v; break;
                case JointTrackType.HSD_A_J_ROTZ: old = jobj.RZ; jobj.RZ = v; break;
                case JointTrackType.HSD_A_J_TRAX: old = jobj.TX; jobj.TX = v; break;
                case JointTrackType.HSD_A_J_TRAY: old = jobj.TY; jobj.TY = v; break;
                case JointTrackType.HSD_A_J_TRAZ: old = jobj.TZ; jobj.TZ = v; break;
                case JointTrackType.HSD_A_J_SCAX: old = jobj.SX; jobj.SX = v; break;
                case JointTrackType.HSD_A_J_SCAY: old = jobj.SY; jobj.SY = v; break;
                case JointTrackType.HSD_A_J_SCAZ: old = jobj.SZ; jobj.SZ = v; break;
                default: matched = false; break;
            }
            if (matched) { applied++; if (Math.Abs(old - v) > 1e-5f) changed++; }
        }
    }
    if (Environment.GetEnvironmentVariable("THE_SHOP_HSD_LOG_POSE") == "1")
    {
        Console.Error.WriteLine($"pose applied: {applied} track values, {changed} differed from bind, across {count} jobjs at frame {frame}");
        // Sample first 10 jobjs' transform after pose application
        for (int i = 0; i < Math.Min(10, jobjs.Count); i++)
        {
            var j = jobjs[i];
            Console.Error.WriteLine($"  jobj[{i}] T=({j.TX:F3},{j.TY:F3},{j.TZ:F3}) R=({j.RX:F3},{j.RY:F3},{j.RZ:F3}) S=({j.SX:F3},{j.SY:F3},{j.SZ:F3})");
        }
    }
}

// ─── safety validators ──────────────────────────────────────────────────────
//
// Compare a candidate .dat against a vanilla reference and emit a JSON
// safety verdict. Schema:
//   {"verdict":"safe|warn|unsafe|unknown",
//    "reasons":[...],   // structural checks that passed
//    "warnings":[...]}  // structural mismatches the user should know about
//
// `safe`    — structurally identical (or close enough); cosmetic-only
// `warn`    — small structural drift; may or may not desync
// `unsafe`  — significant structural mismatch; will likely desync online
// `unknown` — couldn't parse one of the files; conservatively treat as risky
//
// HSDLib does the heavy lifting for us. We just walk the trees and count.

static int ValidateCostume(string[] args)
{
    if (args.Length < 3) { Console.Error.WriteLine("usage: validate-costume <candidate.dat> <vanilla.dat>"); return 2; }
    HSDRawFile cand, vani;
    try { cand = new HSDRawFile(args[1]); }
    catch (Exception e) { return EmitVerdict("unknown", new[] { $"could not open candidate: {e.Message}" }, null); }
    try { vani = new HSDRawFile(args[2]); }
    catch (Exception e) { return EmitVerdict("unknown", new[] { $"could not open vanilla: {e.Message}" }, null); }

    var cRoot = FindCostumeJobj(cand);
    var vRoot = FindCostumeJobj(vani);
    if (cRoot == null || vRoot == null)
    {
        return EmitVerdict("unknown", new[] { "no costume JOBJ root in one or both files" }, null);
    }

    var cBones = WalkBones(cRoot);
    var vBones = WalkBones(vRoot);

    var reasons = new List<string>();
    var warnings = new List<string>();

    // Bone count: hard requirement. Animation indices reference bones
    // positionally; a different bone count → animations look up the wrong
    // joint → desync.
    if (cBones.Count == vBones.Count)
        reasons.Add($"bone_count_match:{cBones.Count}");
    else
        warnings.Add($"bone_count:{cBones.Count}_vs_{vBones.Count}");

    // Tree topology: same depth + same hasDobj pattern at each index.
    int min = Math.Min(cBones.Count, vBones.Count);
    int depthDiffs = 0;
    int dobjDiffs = 0;
    for (int i = 0; i < min; i++)
    {
        if (cBones[i].Depth != vBones[i].Depth) depthDiffs++;
        if (cBones[i].HasDobj != vBones[i].HasDobj) dobjDiffs++;
    }
    if (depthDiffs == 0)
        reasons.Add("topology_match");
    else
        warnings.Add($"topology_drift:{depthDiffs}_of_{min}");

    // DObj presence drift is informational — vanilla skeletons attach
    // visible meshes to specific bones; if the candidate moved which
    // bones carry meshes, the renderer changes but simulation usually
    // doesn't (mesh attachment is a render-only concern). Surface as a
    // soft warning, not a hard one.
    if (dobjDiffs > 0)
        warnings.Add($"mesh_attachment_drift:{dobjDiffs}");

    string verdict;
    if (cBones.Count != vBones.Count) verdict = "unsafe";          // count mismatch is the loud failure mode
    else if (depthDiffs > 0)            verdict = "warn";           // topology drift but same count → may desync
    else                                verdict = "safe";           // structurally identical

    return EmitVerdict(verdict, reasons, warnings);
}

static int ValidateStage(string[] args)
{
    if (args.Length < 3) { Console.Error.WriteLine("usage: validate-stage <candidate.dat> <vanilla.dat>"); return 2; }
    HSDRawFile cand, vani;
    try { cand = new HSDRawFile(args[1]); }
    catch (Exception e) { return EmitVerdict("unknown", new[] { $"could not open candidate: {e.Message}" }, null); }
    try { vani = new HSDRawFile(args[2]); }
    catch (Exception e) { return EmitVerdict("unknown", new[] { $"could not open vanilla: {e.Message}" }, null); }

    var cColl = FindCollData(cand);
    var vColl = FindCollData(vani);
    if (cColl == null || vColl == null)
    {
        return EmitVerdict("unknown", new[] { "no coll_data root in one or both files" }, null);
    }

    var cLines = SerializedLines(cColl);
    var vLines = SerializedLines(vColl);
    var cLedges = cLines.Where(l => l.Property == HSDRaw.Melee.Gr.CollProperty.LedgeGrab).ToList();
    var vLedges = vLines.Where(l => l.Property == HSDRaw.Melee.Gr.CollProperty.LedgeGrab).ToList();

    var reasons = new List<string>();
    var warnings = new List<string>();

    // ── Collision lines ────────────────────────────────────────────────
    // Build canonical sorted multi-sets and compare. Lines flagged
    // Disabled are filtered upstream so background / unreachable
    // collision doesn't trigger false positives. Within each side,
    // duplicates (same coords + flags) are kept — they affect the
    // simulation's per-line iteration even if visually identical.
    var cSorted = SortLines(cLines);
    var vSorted = SortLines(vLines);
    int linesAdded = 0;
    int linesRemoved = 0;
    int linesMoved = 0;
    DiffLineSets(cSorted, vSorted, out linesAdded, out linesRemoved, out linesMoved);
    if (linesAdded == 0 && linesRemoved == 0 && linesMoved == 0)
        reasons.Add($"collision_lines_match:{cLines.Count}");
    else
    {
        if (linesMoved > 0)   warnings.Add($"lines_moved:{linesMoved}");
        if (linesAdded > 0)   warnings.Add($"lines_added:{linesAdded}");
        if (linesRemoved > 0) warnings.Add($"lines_removed:{linesRemoved}");
    }

    // ── Ledges ─────────────────────────────────────────────────────────
    // LedgeGrab lines are the ledges characters can grab. Moves here are
    // the loudest desync category for stage mods because ledge mechanics
    // are central to neutral game.
    int ledgeAdded = 0, ledgeRemoved = 0, ledgeMoved = 0;
    DiffLineSets(SortLines(cLedges), SortLines(vLedges), out ledgeAdded, out ledgeRemoved, out ledgeMoved);
    if (ledgeAdded == 0 && ledgeRemoved == 0 && ledgeMoved == 0)
        reasons.Add($"ledges_match:{vLedges.Count}");
    else
    {
        if (ledgeMoved > 0)   warnings.Add($"ledges_moved:{ledgeMoved}");
        if (ledgeAdded > 0)   warnings.Add($"ledges_added:{ledgeAdded}");
        if (ledgeRemoved > 0) warnings.Add($"ledges_removed:{ledgeRemoved}");
    }

    // ── Blastzones ─────────────────────────────────────────────────────
    // Stored as GeneralPoints of type TopLeftBlastZone / BottomRightBlastZone
    // in map_head, with their position carried by an indexed JOBJ in the
    // GeneralPoints' JOBJReference tree. We extract (X, Y) via the joint's
    // bind-pose translation.
    var cBlast = ExtractBlastZones(cand);
    var vBlast = ExtractBlastZones(vani);
    if (cBlast == null || vBlast == null)
    {
        // Couldn't locate map_head — informational only, don't block.
        warnings.Add("blastzones_unverified");
    }
    else
    {
        bool blastMatch =
            FloatEq(cBlast.Value.tlX, vBlast.Value.tlX) &&
            FloatEq(cBlast.Value.tlY, vBlast.Value.tlY) &&
            FloatEq(cBlast.Value.brX, vBlast.Value.brX) &&
            FloatEq(cBlast.Value.brY, vBlast.Value.brY);
        if (blastMatch)
            reasons.Add("blastzones_match");
        else
            warnings.Add(
                $"blastzones_moved:" +
                $"TL({cBlast.Value.tlX:F1},{cBlast.Value.tlY:F1})_vs_({vBlast.Value.tlX:F1},{vBlast.Value.tlY:F1})_" +
                $"BR({cBlast.Value.brX:F1},{cBlast.Value.brY:F1})_vs_({vBlast.Value.brX:F1},{vBlast.Value.brY:F1})");
    }

    // Verdict: any reachable / interactable change ≠ safe. Disabled lines
    // are already excluded from the comparison so adding background
    // collision wouldn't fail the check.
    bool any =
        linesAdded + linesRemoved + linesMoved + ledgeAdded + ledgeRemoved + ledgeMoved > 0
        || (cBlast.HasValue && vBlast.HasValue && warnings.Any(w => w.StartsWith("blastzones_moved")));
    return EmitVerdict(any ? "unsafe" : "safe", reasons, warnings);
}

static List<StageLine> SerializedLines(HSDRaw.Melee.Gr.SBM_Coll_Data coll)
{
    var verts = coll.Vertices ?? Array.Empty<HSDRaw.Melee.Gr.SBM_CollVertex>();
    var links = coll.Links ?? Array.Empty<HSDRaw.Melee.Gr.SBM_CollLine>();
    var Disabled = HSDRaw.Melee.Gr.CollPhysics.Disabled;
    var out_ = new List<StageLine>(links.Length);
    foreach (var l in links)
    {
        // Skip lines flagged Disabled — they're not part of active
        // collision, can be added/moved without affecting simulation.
        if ((l.CollisionFlag & Disabled) != 0) continue;
        // Index out-of-range guard: malformed mods sometimes have stale
        // vertex indices. Treat as a missing line rather than crashing.
        if (l.VertexIndex1 < 0 || l.VertexIndex1 >= verts.Length) continue;
        if (l.VertexIndex2 < 0 || l.VertexIndex2 >= verts.Length) continue;
        var a = verts[l.VertexIndex1];
        var b = verts[l.VertexIndex2];
        out_.Add(new StageLine(
            (int)Math.Round(a.X * 10f),
            (int)Math.Round(a.Y * 10f),
            (int)Math.Round(b.X * 10f),
            (int)Math.Round(b.Y * 10f),
            l.CollisionFlag & ~Disabled,
            l.Flag));
    }
    return out_;
}

// Sorting key normalizes line orientation (so a → b vs b → a compare equal).
static List<StageLine> SortLines(IEnumerable<StageLine> lines)
{
    var list = lines.Select(l =>
    {
        // Canonical orientation: smaller endpoint first (lex on x then y).
        bool aFirst = (l.Xa10, l.Ya10).CompareTo((l.Xb10, l.Yb10)) <= 0;
        return aFirst
            ? l
            : new StageLine(l.Xb10, l.Yb10, l.Xa10, l.Ya10, l.Physics, l.Property);
    }).ToList();
    list.Sort((p, q) =>
    {
        int c = p.Xa10.CompareTo(q.Xa10); if (c != 0) return c;
        c = p.Ya10.CompareTo(q.Ya10); if (c != 0) return c;
        c = p.Xb10.CompareTo(q.Xb10); if (c != 0) return c;
        c = p.Yb10.CompareTo(q.Yb10); if (c != 0) return c;
        c = ((int)p.Physics).CompareTo((int)q.Physics); if (c != 0) return c;
        return ((int)p.Property).CompareTo((int)q.Property);
    });
    return list;
}

static void DiffLineSets(List<StageLine> a, List<StageLine> b,
                          out int added, out int removed, out int moved)
{
    // Counts:
    //   added   = lines in a not in b (with same coords + flags)
    //   removed = lines in b not in a
    //   moved   = lines in a whose position differs but whose flag set
    //             matches a removed line in b (a re-positioned ledge etc.)
    // Cheap implementation: bag-difference. "moved" is the min of the
    // two sides' surplus per (Physics,Property) flag bucket — it reads
    // as "n lines of this kind got rearranged" which is what users care
    // about more than the raw add/remove split.
    var aBag = new Dictionary<StageLine, int>();
    foreach (var l in a) aBag[l] = aBag.GetValueOrDefault(l) + 1;
    var bBag = new Dictionary<StageLine, int>();
    foreach (var l in b) bBag[l] = bBag.GetValueOrDefault(l) + 1;

    var addedLines = new List<StageLine>();
    var removedLines = new List<StageLine>();
    foreach (var (k, n) in aBag)
    {
        int v = bBag.GetValueOrDefault(k);
        for (int i = 0; i < n - v; i++) addedLines.Add(k);
    }
    foreach (var (k, n) in bBag)
    {
        int v = aBag.GetValueOrDefault(k);
        for (int i = 0; i < n - v; i++) removedLines.Add(k);
    }

    // Bucket by (Physics, Property) and call min(added, removed) per bucket "moved."
    var addBucket = new Dictionary<(HSDRaw.Melee.Gr.CollPhysics, HSDRaw.Melee.Gr.CollProperty), int>();
    foreach (var l in addedLines)
        addBucket[(l.Physics, l.Property)] = addBucket.GetValueOrDefault((l.Physics, l.Property)) + 1;
    var rmBucket = new Dictionary<(HSDRaw.Melee.Gr.CollPhysics, HSDRaw.Melee.Gr.CollProperty), int>();
    foreach (var l in removedLines)
        rmBucket[(l.Physics, l.Property)] = rmBucket.GetValueOrDefault((l.Physics, l.Property)) + 1;

    moved = 0;
    foreach (var (k, n) in addBucket)
    {
        int matched = Math.Min(n, rmBucket.GetValueOrDefault(k));
        moved += matched;
    }
    added = addedLines.Count - moved;
    removed = removedLines.Count - moved;
}

static (float tlX, float tlY, float brX, float brY)? ExtractBlastZones(HSDRawFile file)
{
    foreach (var r in file.Roots)
    {
        if (r.Data is not HSDRaw.Melee.Gr.SBM_Map_Head head) continue;
        var groups = head.GeneralPoints?.Array;
        if (groups == null) continue;
        float? tlX = null, tlY = null, brX = null, brY = null;
        foreach (var grp in groups)
        {
            var jobjRef = grp.JOBJReference;
            var points = grp.Points;
            if (jobjRef == null || points == null) continue;
            var bones = WalkBones(jobjRef);
            // Walked-list shares ordering with the JOBJ tree's flattened
            // index — same indexing the engine uses to look up a
            // GeneralPoint's joint. We need the joint object itself,
            // not just the bone summary, so re-walk the live JOBJs.
            var joints = WalkJoints(jobjRef);
            foreach (var p in points)
            {
                if (p.JOBJIndex < 0 || p.JOBJIndex >= joints.Count) continue;
                var jobj = joints[p.JOBJIndex];
                if (p.Type == HSDRaw.Melee.Gr.PointType.TopLeftBlastZone)
                { tlX = jobj.TX; tlY = jobj.TY; }
                else if (p.Type == HSDRaw.Melee.Gr.PointType.BottomRightBlastZone)
                { brX = jobj.TX; brY = jobj.TY; }
            }
        }
        if (tlX.HasValue && tlY.HasValue && brX.HasValue && brY.HasValue)
            return (tlX.Value, tlY.Value, brX.Value, brY.Value);
    }
    return null;
}

static List<HSD_JOBJ> WalkJoints(HSD_JOBJ root)
{
    var list = new List<HSD_JOBJ>();
    void rec(HSD_JOBJ j) { list.Add(j); if (j.Child != null) rec(j.Child); if (j.Next != null) rec(j.Next); }
    rec(root);
    return list;
}

static bool FloatEq(float a, float b) => Math.Abs(a - b) < 0.05f;

// Find the costume's main JOBJ root. Costumes typically have one root
// whose name matches `Ply<Char>5K[<Slot>]_Share_joint`; we accept any
// HSD_JOBJ root since that's what we'll walk regardless.
static HSD_JOBJ? FindCostumeJobj(HSDRawFile file)
{
    foreach (var r in file.Roots)
        if (r.Data is HSD_JOBJ j) return j;
    return null;
}

// Find the stage's collision data root. HSDLib auto-detects roots whose
// name contains "coll_data" → SBM_Coll_Data.
static HSDRaw.Melee.Gr.SBM_Coll_Data? FindCollData(HSDRawFile file)
{
    foreach (var r in file.Roots)
        if (r.Data is HSDRaw.Melee.Gr.SBM_Coll_Data c) return c;
    return null;
}

static List<_BoneInfo> WalkBones(HSD_JOBJ root)
{
    var bones = new List<_BoneInfo>();
    _Walk(root, 0, bones);
    return bones;
}

static void _Walk(HSD_JOBJ jobj, int depth, List<_BoneInfo> bones)
{
    bones.Add(new _BoneInfo { Depth = depth, HasDobj = jobj.Dobj != null });
    if (jobj.Child != null) _Walk(jobj.Child, depth + 1, bones);
    if (jobj.Next  != null) _Walk(jobj.Next,  depth,     bones);
}

static int EmitVerdict(string verdict, IEnumerable<string>? reasons, IEnumerable<string>? warnings)
{
    var sb = new System.Text.StringBuilder();
    sb.Append("{\"verdict\":\"").Append(verdict).Append('"');
    sb.Append(",\"reasons\":[");
    bool first = true;
    foreach (var r in reasons ?? Array.Empty<string>())
    {
        if (!first) sb.Append(',');
        sb.Append('"').Append(JsonEscape(r)).Append('"');
        first = false;
    }
    sb.Append("],\"warnings\":[");
    first = true;
    foreach (var w in warnings ?? Array.Empty<string>())
    {
        if (!first) sb.Append(',');
        sb.Append('"').Append(JsonEscape(w)).Append('"');
        first = false;
    }
    sb.Append("]}");
    Console.WriteLine(sb.ToString());
    return 0;
}

static class SkinStats
{
    public static int Total;
    public static int NoEnvelopeArr;
    public static int EIdxOob;
    public static int AllBonesNull;
    public static int PartialBonesNull;
    public static int TotalWZero;
    public static List<string> Samples = new();
    public static void Reset()
    {
        Total = NoEnvelopeArr = EIdxOob = AllBonesNull = PartialBonesNull = TotalWZero = 0;
        Samples = new();
    }
    public static void Sample(string s)
    {
        if (Samples.Count < 5) Samples.Add(s);
    }
    public static void Print()
    {
        Console.Error.WriteLine(
            $"--- SkinStats: total={Total} noEnvArr={NoEnvelopeArr} eIdxOOB={EIdxOob} " +
            $"allBonesNull={AllBonesNull} partialBonesNull={PartialBonesNull} totalWZero={TotalWZero} ---");
        foreach (var s in Samples) Console.Error.WriteLine($"  sample: {s}");
    }
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
    public HSDRaw.Common.RENDER_MODE RenderFlags;
    /// The chosen TOBJ's ColorOperation, the GX TEV combine mode. MODULATE
    /// means `result = texture × previous` (so we should multiply by
    /// MOBJ.diffuse when emitting). REPLACE means `result = texture` (don't
    /// multiply). Other ops (ADD/BLEND/SUB) are rare; we approximate as
    /// REPLACE since we can't faithfully reproduce them.
    public HSDRaw.Common.COLORMAP TexColorOp = HSDRaw.Common.COLORMAP.MODULATE;
    public float UvSX = 1, UvSY = 1, UvSZ = 1;
    public float UvRX, UvRY, UvRZ;
    public float UvTX, UvTY, UvTZ;
    public bool HasDiffuseTexture => DiffuseTobj != null && TexFilename != null;
}



class _BoneInfo
{
    public int Depth;
    public bool HasDobj;
}

readonly record struct StageLine(
    int Xa10,           // ×10 to flatten float jitter; equality is exact then
    int Ya10,
    int Xb10,
    int Yb10,
    HSDRaw.Melee.Gr.CollPhysics Physics,
    HSDRaw.Melee.Gr.CollProperty Property);

