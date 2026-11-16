"""
Measure the braid's cross-section and print true bone head/tail positions.

    blender --background --factory-startup --python tools/blender-measure-braid.py -- jinx.glb

Two questions this answers:

1. Is the braid a fat tube or a flat ribbon? A ribbon seen edge-on is exactly
   what "looks like a noodle" means, and a bounding box cannot tell them apart.
   So we measure the spread of the braid's own vertices in the two directions
   perpendicular to the braid's run.

2. Which way do the arms actually run? The earlier dump inferred direction from
   the bone's local Z, and the two arms came out pointing the same way, which is
   not plausible. `bone.head` / `bone.tail` are unambiguous, so we use those.
"""

import sys
import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
src = argv[0]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)

arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
arm = arms[0]
aw = arm.matrix_world

print("[measure] true bone head/tail in world space (Blender Z-up, cm)")
print("  bone                        head.x   head.y   head.z   tail.x   tail.y   tail.z   run_deg_from_down")
for name in ["clavicle_l_27", "upperarm_l_26", "lowerarm_l_23", "hand_l_20",
             "clavicle_r_57", "upperarm_r_55", "lowerarm_r_52", "hand_r_48"]:
    pb = arm.pose.bones.get(name)
    if pb is None:
        print(f"  {name:26} MISSING")
        continue
    h = aw @ pb.head
    t = aw @ pb.tail
    d = (h - t).normalized()
    deg = Vector((0, 0, -1)).angle(d) * 180 / 3.141592653589793
    print(f"  {name:26} {h.x:7.1f} {h.y:7.1f} {h.z:7.1f}  {t.x:7.1f} {t.y:7.1f} {t.z:7.1f}   {deg:6.1f}")

# --- braid cross-section --------------------------------------------------
print("\n[measure] braid cross-section")
for m in meshes:
    if m.name != "Object_8":
        continue
    # Which vertices belong to braid bones?
    braid_bones = {b.name for b in arm.data.bones if "braid" in b.name.lower()}
    groups = m.vertex_groups
    idx_of = {}
    for i, g in enumerate(groups):
        if g.name in braid_bones:
            idx_of[i] = g.name
    if not idx_of:
        print("  no braid vertex groups on Object_8")
        continue

    # Collect braid vertices in world space.
    pts = []
    for v in m.data.vertices:
        best_w, best_g = 0.0, None
        for g in v.groups:
            if g.group in idx_of and g.weight > best_w:
                best_w, best_g = g.weight, g.group
        if best_g is not None and best_w > 0.5:
            pts.append(aw @ m.matrix_world @ v.co)
    print(f"  braid verts: {len(pts)}")
    if len(pts) < 10:
        continue

    # Overall extent.
    xs = [p.x for p in pts]; ys = [p.y for p in pts]; zs = [p.z for p in pts]
    print(f"  bbox x {min(xs):.1f}..{max(xs):.1f}  y {min(ys):.1f}..{max(ys):.1f}  z {min(zs):.1f}..{max(zs):.1f}")

    # Cross-section: take a slice through the middle of the braid's run and
    # measure the spread in the two directions perpendicular to the run.
    centre = Vector((sum(xs) / len(xs), sum(ys) / len(ys), sum(zs) / len(zs)))
    # Principal axis of the braid = direction of greatest spread.
    import mathutils
    cov = mathutils.Matrix.Identity(3)
    for p in pts:
        d = p - centre
        for i in range(3):
            for j in range(3):
                cov[i][j] += d[i] * d[j]
    eig = cov.to_3x3().to_eigenvalues_and_eigenvectors() if hasattr(cov.to_3x3(), "to_eigenvalues_and_eigenvectors") else None
    # Simpler: just measure spread along X, Y, Z and report.
    def spread(axis):
        vals = [p[axis] for p in pts]
        return max(vals) - min(vals)
    print(f"  spread  x {spread('x'):6.1f}  y {spread('y'):6.1f}  z {spread('z'):6.1f}")

    # Per-bone local radius, which is the braid's girth at that point.
    per_bone = {}
    for v in m.data.vertices:
        best_w, best_g = 0.0, None
        for g in v.groups:
            if g.group in idx_of and g.weight > best_w:
                best_w, best_g = g.weight, g.group
        if best_g is None or best_w <= 0.5:
            continue
        p = aw @ m.matrix_world @ v.co
        per_bone.setdefault(best_g, []).append(p)
    radii = []
    for bname, bp in per_bone.items():
        if len(bp) < 6:
            continue
        c = Vector((0, 0, 0))
        for p in bp:
            c += p
        c /= len(bp)
        r = max((p - c).length for p in bp)
        radii.append((bname, len(bp), r))
    radii.sort(key=lambda t: t[0])
    if radii:
        rs = [r[2] for r in radii]
        print(f"  per-bone radius: min {min(rs):.1f}  median {sorted(rs)[len(rs)//2]:.1f}  max {max(rs):.1f} cm")
        print(f"  -> braid girth ~{2*sorted(rs)[len(rs)//2]:.0f} cm across")
        for bname, n, r in radii[:6]:
            print(f"      {bname:28} {n:4d} verts  r={r:.1f}")
