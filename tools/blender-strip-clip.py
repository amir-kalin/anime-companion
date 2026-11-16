"""
Strip the mesh out of a "with skin" animation FBX, keeping only the skeleton
and the action.

    blender --background --factory-startup --python tools/blender-strip-clip.py -- in.fbx out.fbx

## Why

A Mixamo download made with skin carries the whole character - three meshes,
660 bones and all the textures - inside the animation file. three.js throws
that geometry away (AnimationController only reads `animations[0]`), so it is
pure weight: the three clips the user downloaded totalled 16.7 MB, and their
skeleton-only equivalents are a few tens of KB. Over a phone on mobile data
that is the difference between a usable app and a stall.

Removing the meshes cannot change the animation: the action lives on the
armature, and the skeleton is kept exactly as-is.
"""

import sys
import bpy

argv = sys.argv[sys.argv.index("--") + 1:]
if len(argv) < 2:
    raise SystemExit("usage: blender --background --python tools/blender-strip-clip.py -- in.fbx out.fbx")
src, dst = argv[0], argv[1]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=src)

arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
if not arms:
    raise SystemExit("no armature in the clip - nothing to keep")

arm = arms[0]
actions = list(bpy.data.actions)
print(f"[strip] armature bones : {len(arm.data.bones)}")
print(f"[strip] actions        : {[(a.name, len(a.fcurves)) for a in actions]}")
print(f"[strip] meshes to drop : {[(m.name, len(m.data.vertices)) for m in meshes]}")

# Establish the clip's REAL frame range from its own keyframes.
#
# This has to happen before exporting. With bake_anim=True Blender samples over
# the SCENE range, and a fresh scene ends at frame 250 - so three clips whose
# real lengths were 100, 179 and 309 frames were all baked to 250 and came out
# as the same 8.33s motion. Blender never warned; the durations only gave it
# away when the originals and the exports were compared side by side.
keyframes = [
    k.co[0]
    for a in actions
    for fc in a.fcurves
    for k in fc.keyframe_points
]
if not keyframes:
    raise SystemExit("clip has no keyframes - nothing to export")
f_start, f_end = int(min(keyframes)), int(max(keyframes))
bpy.context.scene.frame_start = f_start
bpy.context.scene.frame_end = f_end
print(f"[strip] real range     : {f_start} .. {f_end}  ({(f_end - f_start) / 30:.2f}s @ 30fps)")
print(f"[strip] scene range set to match - was the default 1..250")

# Delete meshes first, then purge the now-unreferenced material/image data,
# which is where most of the file size actually lives.
for m in meshes:
    bpy.data.objects.remove(m, do_unlink=True)
for m in list(bpy.data.meshes):
    bpy.data.meshes.remove(m)
for mat in list(bpy.data.materials):
    bpy.data.materials.remove(mat)
for img in list(bpy.data.images):
    bpy.data.images.remove(img)

# Make sure the action is on the armature and set to every slot, so the export
# cannot silently come out with no animation at all.
if actions and arm.animation_data is None:
    arm.animation_data_create()
arm.animation_data.action = actions[0]
for fc in arm.animation_data.action.fcurves:
    fc.extrapolation = 'CONSTANT'

bpy.ops.object.select_all(action="DESELECT")
arm.select_set(True)
bpy.context.view_layer.objects.active = arm

bpy.ops.export_scene.fbx(
    filepath=dst,
    use_selection=True,
    apply_unit_scale=True,
    global_scale=1.0,
    axis_forward="-Y",
    axis_up="Z",
    object_types={"ARMATURE"},
    add_leaf_bones=False,
    primary_bone_axis="X",
    secondary_bone_axis="Y",
    # bake_anim=True is REQUIRED - it is the flag that actually writes the
    # animation, and with it False this exporter emits an armature with no
    # curves at all. Baking samples over the SCENE frame range, which is why the
    # range above is set from the action's own keyframes first: left at the
    # default 1..250 it silently flattened three different clips to one.
    bake_anim=True,
    bake_anim_use_all_bones=False,   # only bones the clip actually moves
    bake_anim_use_nla_strips=False,
    bake_anim_use_all_actions=False,
    bake_anim_force_startend_keying=True,
    # No keyframe decimation. simplify_factor=2.0 reduced motionless bones to a
# SINGLE keyframe, and the FBX write then emitted tracks like
#   "middle_01_l_6.quaternion"  values=1  valueSize=1
# A quaternion track needs valueSize 4. three's mixer then wrote one float into
# a four-slot quaternion, and 121 of the model's 220 bones went NaN - including
# the armature root, which is why every world matrix in the skeleton was NaN.
bake_anim_simplify_factor=0.0,
    path_mode="STRIP",
)

# Verify the export still carries the motion, and that its length matches the
# source. An armature-only FBX can come out with an empty action, and a wrong
# length is easy to miss because she would simply look like she was idling.
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=dst)
out_arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
out_meshes = [o for o in bpy.data.objects if o.type == "MESH"]
if not out_arms:
    raise SystemExit("export produced no armature")
out_frames = [
    k.co[0]
    for a in bpy.data.actions
    for fc in a.fcurves
    for k in fc.keyframe_points
]
if not out_frames:
    raise SystemExit("export lost the animation - no keyframes survived")
o_start, o_end = int(min(out_frames)), int(max(out_frames))
print(f"[strip] wrote {dst}")
print(f"[strip] verify: bones={len(out_arms[0].data.bones)} meshes={len(out_meshes)} "
      f"range={o_start}..{o_end} ({(o_end - o_start) / 30:.2f}s)")
if (o_end - o_start) != (f_end - f_start):
    raise SystemExit(
        f"LENGTH CHANGED: {f_end - f_start} frames in, {o_end - o_start} out. Refusing a clip "
        "whose duration does not match its source."
    )

# Structural check on every exported track. This is the failure that actually
# shipped once: quaternion tracks came out with valueSize 1 and a single
# keyframe, which three's mixer happily binds and then poisons the target bone
# with NaN. Silently, at runtime, with nothing in the console.
required_size = {".quaternion": 4, ".position": 3, ".scale": 3}
bad = []
for fc in (fc for a in bpy.data.actions for fc in a.fcurves):
    path = fc.data_path
    for suffix, size in required_size.items():
        if path.endswith(suffix):
            size_ok = fc.array_index >= 0 and fc.array_index < size
            keys_ok = len(fc.keyframe_points) >= 2
            if not (size_ok and keys_ok):
                bad.append((path, fc.array_index, len(fc.keyframe_points)))
            break
if bad:
    raise SystemExit(
        f"MALFORMED TRACKS: {len(bad)} curve(s) have an out-of-range array_index or fewer than 2 "
        f"keys. Examples: {bad[:5]}"
    )
print(f"[strip] verified {sum(len(a.fcurves) for a in bpy.data.actions)} curves are structurally valid")