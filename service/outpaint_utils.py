import numpy as np
from PIL import Image
import cv2
from typing import Any


def preprocess_outpaint(direction: str, image: Image.Image):
    top_pad = 0
    right_pad = 0
    bottom_pad = 0
    left_pad = 0
    out_percent = 0.2
    image_ndarray = np.array(image)
    height, width, _ = image_ndarray.shape
    # top
    if direction == "top":
        top_pad = int(height * out_percent) // 8 * 8
    # right
    elif direction == "right":
        right_pad = int(width * out_percent) // 8 * 8
    # bottom
    elif direction == "bottom":
        bottom_pad = int(height * out_percent) // 8 * 8
    # left
    elif direction == "left":
        left_pad = int(width * out_percent) // 8 * 8

    image_ndarray = np.pad(
        image_ndarray,
        [
            [top_pad, bottom_pad],
            [left_pad, right_pad],
            [0, 0],
        ],
        mode="edge",
        # mode="constant",
        # constant_values=255,
    )
    inpaint_mask = np.zeros((height, width, 3), dtype=np.uint8)
    inpaint_mask = np.pad(
        inpaint_mask,
        [
            [top_pad, bottom_pad],
            [left_pad, right_pad],
            [0, 0],
        ],
        mode="constant",
        constant_values=255,
    )

    image_ndarray = Image.fromarray(image_ndarray)
    
    inpaint_mask = outpaint_canny_gradient(
        inpaint_mask, top_pad, bottom_pad, left_pad, right_pad
    )
    # if not os.path.exists("./static/test"):
    #     os.makedirs("./static/test", exist_ok=True)
    # inpaint_image.save("./static/test/outpaint_input.png")
    # inpaint_mask.save("./static/test/outpaint_mask.png")

    return image_ndarray, inpaint_mask


def gradient_dir(region: np.ndarray[Any, Any], dir):
    h, w, _ = region.shape
    if dir == "left":
        for x in range(w):
            region[:, x] = int(255 - 255 * (x / w))
    elif dir == "right":
        for x in range(w):
            region[:, x] = int(255 * (x / w))
    elif dir == "top":
        for y in range(h):
            region[y:,] = int(255 - 255 * (y / h))
    elif dir == "bottom":
        for y in range(h):
            region[y:,] = int(255 * (y / h))
    return region


def outpaint_canny_gradient(
    image: Image.Image | np.ndarray,
    top_pad: int,
    bottom_pad: int,
    left_pad: int,
    right_pad: int,
):
    if type(image) == Image.Image:
        img_ndata = np.array(image)
    else:
        img_ndata = image
    h, w, _ = img_ndata.shape
    dist = 30
    if top_pad > 0:
        region = img_ndata[top_pad - dist : top_pad + dist, :]
        img_ndata[top_pad - dist : top_pad + dist, :] = gradient_dir(region, "top")
    if bottom_pad > 0:
        region = img_ndata[h - bottom_pad - dist : h - bottom_pad + dist, :]
        img_ndata[h - bottom_pad - dist : h - bottom_pad + dist, :] = gradient_dir(
            region, "bottom"
        )
    if left_pad > 0:
        region = img_ndata[:, left_pad - dist : left_pad + dist]
        img_ndata[:, left_pad - dist : left_pad + dist] = gradient_dir(region, "left")
    if right_pad > 0:
        region = img_ndata[:, w - right_pad - dist : w - right_pad + dist]
        img_ndata[:, w - right_pad - dist : w - right_pad + dist] = gradient_dir(
            region, "right"
        )
    # top, bottom, left, right = inpaint_utils.detect_mask_valid_edge(img_ndata)
    # img_ndata = cv2.GaussianBlur(img_ndata[top:bottom, left:right], (5, 5), 0)
    return Image.fromarray(img_ndata)


def outpaint_canny_blur(
    image: Image.Image | np.ndarray,
    top_pad: int,
    bottom_pad: int,
    left_pad: int,
    right_pad: int,
):
    if type(image) == Image.Image:
        img_ndata = np.array(image)
    else:
        img_ndata = image
    h, w, _ = img_ndata.shape
    if top_pad > 0:
        region = img_ndata[top_pad - 10 : top_pad + 10, :]
        img_ndata[top_pad - 10 : top_pad + 10, :] = cv2.GaussianBlur(region, (5, 5), 0)
    if bottom_pad > 0:
        region = img_ndata[h - bottom_pad - 10 : h - bottom_pad + 10, :]
        img_ndata[h - bottom_pad - 10 : h - bottom_pad + 10, :] = cv2.GaussianBlur(
            region, (5, 5), 0
        )
    if left_pad > 0:
        region = img_ndata[:, left_pad - 10 : left_pad + 10]
        img_ndata[:, left_pad - 10 : left_pad + 10] = cv2.GaussianBlur(
            region, (5, 5), 0
        )
    if right_pad > 0:
        region = img_ndata[:, w - right_pad - 10 : w - right_pad + 10]
        img_ndata[:, w - right_pad - 10 : w - right_pad + 10] = cv2.GaussianBlur(
            region, (5, 5), 0
        )

    return Image.fromarray(img_ndata)


def slice_by_direction(
    inpaint_image: Image.Image, mask_image: Image.Image, direction: int, max_size: int
):
    top = 0
    right = 0
    bottom = 0
    left = 0
    # up
    if direction & 1 == 1:
        right = inpaint_image.width
        bottom = min(inpaint_image.height, max_size)
    # right
    if direction & 2 == 2:
        left = max(inpaint_image.width - max_size, 0)
        right = inpaint_image.width
        bottom = inpaint_image.height
    # bottom
    if direction & 4 == 4:
        top = max(inpaint_image.height - max_size, 0)
        right = inpaint_image.width
        bottom = inpaint_image.height
    # left
    if direction & 8 == 8:
        right = min(inpaint_image.width, max_size)
        bottom = inpaint_image.height
    return (
        inpaint_image.crop((top, right, bottom, left)),
        mask_image.crop((top, right, bottom, left)),
        (top, right, bottom, left),
    )
