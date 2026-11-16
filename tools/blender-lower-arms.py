"""
Lower the arms from their splayed rest pose into a natural hang, and re-export.

    blender --background --factory-startup --python tools/blender-lower-arms.py -- jinx.glb out.glb 36

The model's rest pose has the upper arms running out and down at roughly 48
degrees from vertical - a wide A-pose. Every Mixamo clip is authored for a
T-pose character and holds the arms out, so she stands with her hands in the
air doing nothing.

Changing a skinned rest pose takes three steps, and skipping the middle one is
what makes this look like it failed:

  1. rotate the bones into the new pose
  2. bake that pose into the mesh vertices
  3. set the new pose as the rest pose and clear the pose

Step 3 alone (which is all `pose.armature_apply` does) leaves the bind matrices
pointing at the old pose, so the mesh keeps rendering the old arm position while
the bones report the new one - the render and the bone data disagree, and the
character does not move. Baking the pose into the vertices first is what makes
the two agree.
"""

import sys
import os
import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
src, dst = argv[0], argv[1]
theta = float(argv[2]) if len(argv) > 2 else 36.0

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)

arm = [o for o in bpy.data.objects if o.type == "ARMATURE"][0]
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
bpy.context.view_layer.update()
aw = arm.matrix_world


def visual_deg(name):
    """Angle from straight down of the bone's visual (tail->head) direction."""
    pb = arm.pose.bones[name]
    m = aw @ pb.matrix
    lx = (m.to_3x3() @ Vector((1, 0, 0))).normalized()
    visual = lx if lx.z < 0 else -lx
    return Vector((0, 0, -1)).angle(visual) * 180 / 3.141592653589793


def report(tag):
    bpy.context.view_layer.update()
    print(f"[lower] {tag} " + "  ".join(
        f"{n}={visual_deg(n):.1f}" for n in ("upperarm_l_26", "upperarm_r_55")))


report("before")

# --- 1. rotate the upper arms about the GLOBAL Y axis ------------------------
bpy.ops.object.select_all(action="DESELECT")
arm.select_set(True)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="POSE")

for name, sign in (("upperarm_l_26", +1.0), ("upperarm_r_55", -1.0)):
    bpy.ops.pose.select_all(action="DESELECT")
    arm.data.bones[name].select = True
    bpy.context.scene.transform_orientation_slots[0].type = "GLOBAL"
    bpy.ops.transform.rotate(
        value=sign * theta * 3.141592653589793 / 180.0,
        orient_type="GLOBAL",
        orient_matrix_type="GLOBAL",
        constraint_axis=(False, True, False),
    )

report("posed ")

# --- 2. bake the pose into the mesh vertices --------------------------------
bpy.ops.object.mode_set(mode="OBJECT")
for m in meshes:
    bpy.ops.object.select_all(action="DESELECT")
    m.select_set(True)
    bpy.context.view_layer.objects.active = m
    for mod in list(m.modifiers):
        if mod.type == "ARMATURE":
            bpy.ops.object.modifier_apply(modifier=mod.name)
    # Re-add the armature so the mesh stays bound to the rig.
    mod = m.modifiers.new(name="Armature", type="ARMATURE")
    mod.object = arm
    mod.use_deform_preserve_volume = False

# --- 3. set the new pose as the rest pose -----------------------------------
bpy.ops.object.select_all(action="DESELECT")
arm.select_set(True)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="POSE")
bpy.ops.pose.select_all(action="SELECT")
bpy.ops.pose.armature_apply(selected=True)
bpy.ops.object.mode_set(mode="OBJECT")
bpy.context.view_layer.update()

report("baked ")

os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB")
print(f"[lower] wrote {dst}")
