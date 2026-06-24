#!/usr/bin/env python3
"""
Decimate STL meshes (quadric decimation) and re-save as binary STL.

Usage:
  decimate.py models/*.stl            # in place, default targets
  decimate.py --target 12000 a.stl    # force a triangle target
"""
import argparse
import os
import sys

import open3d as o3d


def target_for(path):
    name = os.path.basename(path).lower()
    if "landmark" in name:
        return 4000
    if name.startswith("ivc.") or name.startswith("ivc_"):
        return 5000
    return 15000  # main chambers / organs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--target", type=int, default=None,
                    help="force triangle target for all files")
    args = ap.parse_args()

    total_before = total_after = 0
    for f in args.files:
        mesh = o3d.io.read_triangle_mesh(f)
        n0 = len(mesh.triangles)
        tgt = args.target or target_for(f)
        if n0 > tgt:
            mesh = mesh.simplify_quadric_decimation(target_number_of_triangles=tgt)
        mesh.remove_duplicated_vertices()
        mesh.remove_degenerate_triangles()
        mesh.compute_vertex_normals()
        n1 = len(mesh.triangles)
        o3d.io.write_triangle_mesh(f, mesh, write_ascii=False)
        b = os.path.getsize(f)
        total_before += n0
        total_after += n1
        print(f"{os.path.basename(f):22s} {n0:7d} -> {n1:6d} tris  ({b//1024} KB)")

    print(f"\nTOTAL triangles {total_before} -> {total_after}")


if __name__ == "__main__":
    main()
