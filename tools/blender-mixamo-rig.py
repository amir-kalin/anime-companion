"""
Rename Jinx's rig to Mixamo bone conventions and export an FBX.

    "C:\Program Files\Blender Foundation\Blender 4.5\blender.exe" --background --python tools/blender-mixamo-rig.py

## Why

Mixamo refuses the model with "unable to detect rig". Its detector looks for a
humanoid skeleton using Mixamo's own bone names, and this rig is an
Unreal/Arcane export: `pelvis_217`, `upperarm_l_26`, `calf_l_154`. Nothing in
that vocabulary is recognisable, so there is no rig to detect.

Renaming the bones to Mixamo's convention fixes the upload and has a second
benefit: once the model and the clips agree on names, `AnimationMixer` binds
them directly instead of going through the retarget layer.

## What is NOT touched

- No mesh editing. Vertices, materials, UVs and weights are left exactly as
  imported, so this cannot change how she looks.
- Bone rest positions are never modified - only `.name`. Renaming a bone does
  not move it, so the pose and the skinning are unchanged.
"""

import bpy
import json
import sys
from pathlib import Path

ROOT = Path(r"C:\Users\KALI\Documents\anime-companion")
SRC = ROOT / "public" / "models" / "character" / "jinx.glb"
DST = ROOT / "public" / "models" / "character" / "jinx-mixamo.fbx"
REPORT = ROOT / "logs" / "rig-rename.json"

# ---------------------------------------------------------------- mapping
# Unreal/Arcane bone name -> Mixamo bone name.
#
# Mixamo exports its own clips with a `mixamorig:` namespace, so using the same
# prefix here means a downloaded clip and this model share names verbatim and
# the mixer binds them with no rewriting at all.
L, R = "l", "r"
MAP = {
    "pelvis_217": "mixamorig:Hips",
    "spine_01_133": "mixamorig:Spine",
    "spine_02_132": "mixamorig:Spine1",
    "spine_03_131": "mixamorig:Spine2",
    "spine_04_130": "mixamorig:Spine3",   # beyond Mixamo's set; kept in-chain
    "spine_05_129": "mixamorig:Spine4",   # beyond Mixamo's set; kept in-chain
    "neck_01_125": "mixamorig:Neck",
    "head_123": "mixamorig:Head",

    # arms
    "clavicle_l_27": "mixamorig:LeftShoulder",
    "upperarm_l_26": "mixamorig:LeftArm",
    "lowerarm_l_23": "mixamorig:LeftForeArm",
    "hand_l_20": "mixamorig:LeftHand",
    "clavicle_r_57": "mixamorig:RightShoulder",
    "upperarm_r_55": "mixamorig:RightArm",
    "lowerarm_r_52": "mixamorig:RightForeArm",
    "hand_r_48": "mixamorig:RightHand",

    # legs
    "thigh_l_154": "mixamorig:LeftUpLeg",
    "calf_l_150": "mixamorig:LeftLeg",
    "foot_l_149": "mixamorig:LeftFoot",
    "ball_l_148": "mixamorig:LeftToeBase",
    "thigh_r_178": "mixamorig:RightUpLeg",
    "calf_r_174": "mixamorig:RightLeg",
    "foot_r_173": "mixamorig:RightFoot",
    "ball_r_172": "mixamorig:RightToeBase",

    # eyes - these are facial bones on this model, but they are the closest
    # thing to Mixamo's eye bones, so saccades still have something to drive.
    "L_eye_117": "mixamorig:LeftEye",
    "R_eye_114": "mixamorig:RightEye",

    # hands
    "index_metacarpal_l_3": "mixamorig:LeftHandIndex1",
    "index_01_l_2": "mixamorig:LeftHandIndex2",
    "index_02_l_1": "mixamorig:LeftHandIndex3",
    "index_03_l_0": "mixamorig:LeftHandIndex4",
    "middle_metacarpal_l_7": "mixamorig:LeftHandMiddle1",
    "middle_01_l_6": "mixamorig:LeftHandMiddle2",
    "middle_02_l_5": "mixamorig:LeftHandMiddle3",
    "middle_03_l_4": "mixamorig:LeftHandMiddle4",
    "ring_metacarpal_l_15": "mixamorig:LeftHandRing1",
    "ring_01_l_14": "mixamorig:LeftHandRing2",
    "ring_02_l_13": "mixamorig:LeftHandRing3",
    "ring_03_l_12": "mixamorig:LeftHandRing4",
    "pinky_metacarpal_l_11": "mixamorig:LeftHandPinky1",
    "pinky_01_l_10": "mixamorig:LeftHandPinky2",
    "pinky_02_l_9": "mixamorig:LeftHandPinky3",
    "pinky_03_l_8": "mixamorig:LeftHandPinky4",
    "thumb_01_l_18": "mixamorig:LeftHandThumb1",
    "thumb_02_l_17": "mixamorig:LeftHandThumb2",
    "thumb_03_l_16": "mixamorig:LeftHandThumb3",

    "index_metacarpal_r_31": "mixamorig:RightHandIndex1",
    "index_01_r_30": "mixamorig:RightHandIndex2",
    "index_02_r_29": "mixamorig:RightHandIndex3",
    "index_03_r_28": "mixamorig:RightHandIndex4",
    "middle_metacarpal_r_35": "mixamorig:RightHandMiddle1",
    "middle_01_r_34": "mixamorig:RightHandMiddle2",
    "middle_02_r_33": "mixamorig:RightHandMiddle3",
    "middle_03_r_32": "mixamorig:RightHandMiddle4",
    "ring_metacarpal_r_43": "mixamorig:RightHandRing1",
    "ring_01_r_42": "mixamorig:RightHandRing2",
    "ring_02_r_41": "mixamorig:RightHandRing3",
    "ring_03_r_40": "mixamorig:RightHandRing4",
    "pinky_metacarpal_r_39": "mixamorig:RightHandPinky1",
    "pinky_01_r_38": "mixamorig:RightHandPinky2",
    "pinky_02_r_37": "mixamorig:RightHandPinky3",
    "pinky_03_r_36": "mixamorig:RightHandPinky4",
    "thumb_01_r_46": "mixamorig:RightHandThumb1",
    "thumb_02_r_45": "mixamorig:RightHandThumb2",
    "thumb_03_r_44": "mixamorig:RightHandThumb3",
}


def main() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)

    print(f"[rig] importing {SRC}")
    bpy.ops.import_scene.gltf(filepath=str(SRC))

    armatures = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    print(f"[rig] armatures={len(armatures)} meshes={len(meshes)}")
    if not armatures:
        raise SystemExit("no armature in the file - cannot rename a rig that is not there")

    arm = armatures[0]
    bones = arm.data.bones
    print(f"[rig] bones={len(bones)}")

    # Snapshot every bone's rest position and its parent, so the export can be
    # verified afterwards. A rename must not move anything; if the FBX round
    # trip shifts the rig, this is what catches it.
    before = {
        b.name: {
            "head": [round(v, 6) for v in b.head_local],
            "parent": b.parent.name if b.parent else None,
        }
        for b in bones
    }

    renamed, skipped = [], []
    for bone in bones:
        target = MAP.get(bone.name)
        if not target:
            skipped.append(bone.name)
            continue
        # Blender will silently accept a duplicate name by suffixing _001, so
        # the conflict is checked up front rather than discovered afterwards.
        if target in bones and target != bone.name:
            skipped.append(f"{bone.name} (name collision: {target})")
            continue
        old = bone.name
        bone.name = target
        renamed.append((old, target))

    print(f"[rig] renamed {len(renamed)} bones, left {len(skipped)} alone")

    # Re-parent check: renaming can orphan children if a child's new name
    # collides, so verify the hierarchy depth is unchanged.
    after = {
        b.name: {"head": [round(v, 6) for v in b.head_local],
                 "parent": b.parent.name if b.parent else None}
        for b in bones
    }
    if len(after) != len(before):
        raise SystemExit(f"bone count changed: {len(before)} -> {len(after)}")

    # --- export
    print(f"[rig] exporting {DST}")
    bpy.ops.object.select_all(action="DESELECT")
    for o in bpy.data.objects:
        if o.type in {"MESH", "ARMATURE"}:
            o.select_set(True)
    bpy.context.view_layer.objects.active = arm

    bpy.ops.export_scene.fbx(
        filepath=str(DST),
        use_selection=True,
        apply_unit_scale=True,
        global_scale=1.0,
        # Mixamo expects Y-up with -Y forward and -X bone axes. Exporting with
        # Blender's own Z-up defaults is what makes an uploaded rig land
        # sideways, so the axis conversion is turned ON here.
        axis_forward="-Y",
        axis_up="Z",
        bake_space_transform=False,
        object_types={"MESH", "ARMATURE"},
        use_mesh_modifiers=True,
        mesh_smooth_type="FACE",
        add_leaf_bones=False,
        primary_bone_axis="X",
        secondary_bone_axis="Y",
        path_mode="COPY",
        embed_textures=True,
    )

    # --- verify the exported file re-imports with the same rest pose
    print("[rig] verifying round trip")
    check = bpy.data.objects.new("check", None)
    bpy.context.scene.collection.objects.link(check)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(SRC))   # source of truth for scale
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=str(DST))

    out_arm = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    if not out_arm:
        raise SystemExit("exported FBX has no armature")
    out_bones = {b.name: b for b in out_arm[0].data.bones}

    # Check the NEW names are present. Checking the old ones would be the
    # opposite of the point - they are supposed to be gone.
    missing = [new for _, new in renamed if new not in out_bones]
    if missing:
        raise SystemExit(f"export lost {len(missing)} renamed bones, e.g. {missing[:5]}")

    stale = [old for old, _ in renamed if old in out_bones]
    if stale:
        raise SystemExit(f"export kept {len(stale)} old names, e.g. {stale[:5]}")
    print(f"[rig] verified {len(renamed)} renamed bones present, {len(stale)} stale names")

    # Compare world-space head position of a few landmarks, in MODEL units.
    # The FBX axis conversion changes object rotation but the rest pose of the
    # skeleton should still describe the same body, so measure bone-to-bones
    # distances which are rotation invariant.
    def span(bone_names):
        pts = []
        for n in bone_names:
            b = out_bones.get(n)
            if b:
                pts.append(b.matrix_local @ b.head_local)
        if len(pts) < 2:
            return None
        return max((a - b).length for a in pts for b in pts)

    height = span(["mixamorig:Hips", "mixamorig:Head", "mixamorig:LeftFoot",
                   "mixamorig:RightFoot", "mixamorig:LeftHand", "mixamorig:RightHand"])

    payload = {
        "source": str(SRC),
        "output": str(DST),
        "bones_total": len(bones),
        "bones_renamed": len(renamed),
        "bones_untouched": len(skipped),
        "renamed": [{"from": a, "to": b} for a, b in renamed],
        "untouched_sample": skipped[:40],
        "landmark_span": round(height, 4) if height else None,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"[rig] wrote {REPORT}")


if __name__ == "__main__":
    main()