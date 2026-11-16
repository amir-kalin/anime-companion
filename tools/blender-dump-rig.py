"""
Dump the arm chain and braid geometry from jinx.glb.

    blender --background --factory-startup --python tools/blender-dump-rig.py -- jinx.glb

Prints, for every bone in the arm and leg chains, the world-space direction
the bone runs in. That is what tells us which local axis is "down the arm",
so the rest-pose fix can be computed instead of guessed.

Also dumps the braid meshes: vertex count, bounding box, and the cross-section
width, because "the braids look like noodles" is a geometry question and the
only way to answer it is to measure the mesh.
"""

import sys
import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
if not argv:
    raise SystemExit("usage: blender --background --python tools/blender-dump-rig.py -- jinx.glb")
src = argv[0]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)

arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
if not arms:
    raise SystemExit("no armature in the glb")
arm = arms[0]

print(f"[dump] objects        : {[(o.name, o.type) for o in bpy.data.objects]}")
print(f"[dump] armature bones : {len(arm.data.bones)}")
print(f"[dump] meshes         : {[(m.name, len(m.data.vertices)) for m in meshes]}")

# World matrix of the armature, so a pose bone's matrix can be lifted to world.
arm_world = arm.matrix_world

WATCH = [
    "pelvis_217", "spine_01_133", "spine_02_132", "spine_03_131",
    "clavicle_l_27", "upperarm_l_26", "lowerarm_l_23", "hand_l_20",
    "clavicle_r_57", "upperarm_r_55", "lowerarm_r_52", "hand_r_48",
    "thigh_l_14", "calf_l_13", "foot_l_12",
    "thigh_r_42", "calf_r_41", "foot_r_40",
]

print("\n[dump] bone world directions (arm + leg chains)")
print("  bone                        dir.x    dir.y    dir.z   len")
for name in WATCH:
    pb = arm.pose.bones.get(name)
    if pb is None:
        print(f"  {name:26} MISSING")
        continue
    m = arm_world @ pb.matrix
    # The bone's own local axes, lifted to world, so we can see which one
    # runs along the bone.
    axes = {
        "X": (m.to_quaternion() @ Vector((1, 0, 0))).normalized(),
        "Y": (m.to_quaternion() @ Vector((0, 1, 0))).normalized(),
        "Z": (m.to_quaternion() @ Vector((0, 0, 1))).normalized(),
    }
    # Direction from this bone's tail to its head, in world space.
    tail = m.translation
    head = (arm_world @ pb.matrix).translation + (
        m.to_quaternion() @ Vector((0, 0, 1))
    ) * pb.length
    d = (head - tail).normalized()
    print(f"  {name:26} {d.x:7.3f} {d.y:7.3f} {d.z:7.3f}  len={pb.length:.1f}")
    print(f"      local X -> world {axes['X'].x:6.2f} {axes['X'].y:6.2f} {axes['X'].z:6.2f}"
          f"   Y -> {axes['Y'].x:6.2f} {axes['Y'].y:6.2f} {axes['Y'].z:6.2f}"
          f"   Z -> {axes['Z'].x:6.2f} {axes['Z'].y:6.2f} {axes['Z'].z:6.2f}")

# --- braid geometry -------------------------------------------------------
print("\n[dump] braid meshes")
for m in meshes:
    if "braid" not in m.name.lower() and "hair" not in m.name.lower():
        continue
    verts = [v.co for v in m.data.vertices]
    if not verts:
        continue
    xs = [v.x for v in verts]
    ys = [v.y for v in verts]
    zs = [v.z for v in verts]
    print(f"  {m.name}: {len(verts)} verts")
    print(f"    bbox x {min(xs):.1f}..{max(xs):.1f}  y {min(ys):.1f}..{max(ys):.1f}  z {min(zs):.1f}..{max(zs):.1f}")
    print(f"    size  x {max(xs)-min(xs):.1f}  y {max(ys)-min(ys):.1f}  z {max(zs)-min(zs):.1f}")

# --- every mesh, so we know what is what ----------------------------------
print("\n[dump] all meshes with bbox")
for m in meshes:
    verts = [v.co for v in m.data.vertices]
    if not verts:
        continue
    xs = [v.x for v in verts]
    ys = [v.y for v in verts]
    zs = [v.z for v in verts]
    print(f"  {m.name:34} {len(verts):6d} verts  "
          f"x {min(xs):7.1f}..{max(xs):7.1f}  y {min(ys):7.1f}..{max(ys):7.1f}  z {min(zs):7.1f}..{max(zs):7.1f}")
