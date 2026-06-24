#!/usr/bin/env python3
"""
Pre-bake a DICOM file or a folder of CT slices into a compact volume
binary the glasses web app can fetch directly (no file picker needed).

Output format (.vol):
  magic    : 4 bytes  b'VOL1'
  width    : uint16 little-endian
  height   : uint16 little-endian
  depth    : uint16 little-endian
  data     : width*height*depth bytes (Uint8, windowed 0-255)

Usage:
  prebake.py --file  /path/to/scan.dcm        --out public/tee.vol
  prebake.py --dir   /path/to/ct_slices       --out public/ct.vol
  Optional: --dim 160   (max cube dimension, default 160)
"""

import argparse
import glob
import os
import struct
import sys

import numpy as np
import pydicom


def load_series(path):
    """Return a 3D float array in real (Hounsfield) units, ordered foot->head."""
    files = []
    for f in glob.glob(os.path.join(path, "*")):
        if os.path.isfile(f):
            files.append(f)

    slices = []
    for f in files:
        try:
            ds = pydicom.dcmread(f, force=True)
            if not hasattr(ds, "PixelData"):
                continue
            slices.append(ds)
        except Exception:
            continue

    if not slices:
        sys.exit("No readable DICOM slices found in folder.")

    # Sort by ImagePositionPatient Z, fall back to InstanceNumber
    def sort_key(ds):
        ipp = getattr(ds, "ImagePositionPatient", None)
        if ipp is not None and len(ipp) == 3:
            return float(ipp[2])
        return float(getattr(ds, "InstanceNumber", 0))

    slices.sort(key=sort_key)

    slope = float(getattr(slices[0], "RescaleSlope", 1) or 1)
    intercept = float(getattr(slices[0], "RescaleIntercept", 0) or 0)

    vol = np.stack([s.pixel_array.astype(np.float32) for s in slices], axis=0)
    vol = vol * slope + intercept  # -> Hounsfield units
    return vol, slices[0]


def load_single(path):
    """Return a 3D float array from a single (possibly multi-frame) DICOM."""
    ds = pydicom.dcmread(path, force=True)
    arr = ds.pixel_array.astype(np.float32)
    slope = float(getattr(ds, "RescaleSlope", 1) or 1)
    intercept = float(getattr(ds, "RescaleIntercept", 0) or 0)
    arr = arr * slope + intercept
    if arr.ndim == 2:
        arr = arr[np.newaxis, ...]  # single slice -> depth 1
    return arr, ds


def to_grayscale(vol):
    """Collapse an RGB volume (..., 3) to single-channel luminance."""
    if vol.ndim == 4 and vol.shape[-1] == 3:
        return (0.299 * vol[..., 0] + 0.587 * vol[..., 1] + 0.114 * vol[..., 2])
    return vol


def window_and_downsample(vol, ds, max_dim):
    """Apply window/level, downsample, return Uint8 (depth, height, width)."""
    vol = to_grayscale(vol)
    # Prefer DICOM window tags, else auto from percentiles (robust to outliers)
    wc = getattr(ds, "WindowCenter", None)
    ww = getattr(ds, "WindowWidth", None)
    if isinstance(wc, pydicom.multival.MultiValue):
        wc = wc[0]
    if isinstance(ww, pydicom.multival.MultiValue):
        ww = ww[0]

    if ww is None or float(ww) < 1:
        lo = np.percentile(vol, 1.0)
        hi = np.percentile(vol, 99.5)
        wc = (lo + hi) / 2.0
        ww = (hi - lo) or 1.0
    wc = float(wc)
    ww = float(ww)

    w_min = wc - ww / 2.0
    norm = np.clip((vol - w_min) / ww, 0.0, 1.0)
    u8 = (norm * 255).astype(np.uint8)

    d, h, w = u8.shape
    td = min(d, max_dim)
    th = min(h, max_dim)
    tw = min(w, max_dim)

    zi = (np.arange(td) * d / td).astype(int)
    yi = (np.arange(th) * h / th).astype(int)
    xi = (np.arange(tw) * w / tw).astype(int)
    small = u8[np.ix_(zi, yi, xi)]
    return small, (tw, th, td)


def write_vol(out_path, data, dims):
    tw, th, td = dims
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "wb") as fh:
        fh.write(b"VOL1")
        fh.write(struct.pack("<HHH", tw, th, td))
        fh.write(data.tobytes())
    size_mb = os.path.getsize(out_path) / 1e6
    print(f"Wrote {out_path}  {tw}x{th}x{td}  {size_mb:.1f} MB")


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--file", help="single DICOM file")
    g.add_argument("--dir", help="folder of CT slices")
    ap.add_argument("--out", required=True, help="output .vol path")
    ap.add_argument("--dim", type=int, default=160, help="max cube dimension")
    args = ap.parse_args()

    if args.file:
        vol, ds = load_single(args.file)
    else:
        vol, ds = load_series(args.dir)

    print(f"Loaded volume shape (D,H,W) = {vol.shape}, HU range "
          f"[{vol.min():.0f}, {vol.max():.0f}]")
    data, dims = window_and_downsample(vol, ds, args.dim)
    write_vol(args.out, data, dims)


if __name__ == "__main__":
    main()
