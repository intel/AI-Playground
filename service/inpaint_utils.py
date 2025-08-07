from typing import Tuple
import numpy as np
from PIL import Image
import cv2


def get_image_ndarray(image: Image.Image | np.ndarray) -> np.ndarray:
    if isinstance(image, Image.Image):
        return np.array(image)
    else:
        return image


def detect_mask_valid_edge(
    mask_image: Image.Image | np.ndarray,
) -> Tuple[int, int, int, int]:
    mask = get_image_ndarray(mask_image)

    indices = np.where(mask > 0)

    top, bottom = np.min(indices[0]), np.max(indices[0])

    left, right = np.min(indices[1]), np.max(indices[1])

    print("detect top:{},bottom:{}, left:{},right:{}".format(top, bottom, left, right))

    return (left, top, right, bottom)


def pre_input_and_mask(
    image: Image.Image, mask: Image.Image
) -> tuple[Image.Image, Image.Image, tuple[int, int, int, int]]:
    iw, ih = image.size
    mask_resize = mask.resize(image.size)
    ml, mt, mr, mb = detect_mask_valid_edge(mask_resize)
    # if mask valid edge equals input image edge, don't slice image
    if ml == 0 and mt == 0 and mb == ih - 1 and mr == iw - 1:
        return image, mask_resize, (0, 0)

    mask_width_half = (mr - ml) // 2
    mask_height_half = (mb - mt) // 2

    slice_width_half = 0
    slice_height_half = 0
    while mask_width_half > slice_width_half:
        slice_width_half += 128
    while mask_height_half > slice_height_half:
        slice_height_half += 128

    center_x = ml + mask_width_half
    center_y = mt + mask_height_half

    left = max(0, center_x - slice_width_half)
    top = max(0, center_y - slice_height_half)
    right = min(iw, center_x + slice_width_half)
    bottom = min(ih, center_y + slice_height_half)

    # slice_height = bottom - top
    # slice_width = right - left

    # calc_out_size(slice_width, slice_height)

    slice_box = (left, top, right, bottom)

    return image.crop(slice_box), mask_resize.crop(slice_box), slice_box


def calc_out_size(width: int, height: int, is_sdxl=False) -> tuple[int, int, int]:
    max = 1536 if is_sdxl else 768
    if width > height:
        if width > max:
            radio = width / max
            return max, make_multiple_of_8(int(height / radio)), radio
    elif height > max:
        radio = height / max
        return make_multiple_of_8(int(width / radio)), max, radio
    return make_multiple_of_8(width), make_multiple_of_8(height), 1


def make_multiple_of_8(value: int):
    return value // 8 * 8


def resize_by_max(image: Image.Image, max_size: int, multiple_of_8=True):
    if image.width > max_size or image.height > max_size:
        if image.width > image.height:
            downscale_ratio = image.width / max_size
            downscale_width = int(image.width / downscale_ratio)
            downscale_height = int(image.height / downscale_ratio)
            if multiple_of_8:
                new_width = make_multiple_of_8(downscale_width)
                new_height = make_multiple_of_8(downscale_height)
            return image.resize((new_width, new_height)), downscale_ratio
        else:
            downscale_ratio = image.height / max_size
            downscale_width = int(image.width / downscale_ratio)
            downscale_height = int(image.height / downscale_ratio)
            if multiple_of_8:
                new_width = make_multiple_of_8(downscale_width)
                new_height = make_multiple_of_8(downscale_height)
            return image.resize((new_width, new_height)), downscale_ratio
    return image, 1


def slice_image(image: np.ndarray | Image.Image):
    image = get_image_ndarray(image)
    height, width, _ = image.shape
    slice_size = min(width // 2, height // 3)

    slices = []

    for h in range(3):
        for w in range(2):
            left = w * slice_size
            upper = h * slice_size
            right = left + slice_size
            lower = upper + slice_size

            if w == 1 and right > width:
                left -= right - width
                right = width
            if h == 2 and lower > height:
                upper -= lower - height
                lower = height

            slice = image[upper:lower, left:right]
            slices.append(slice)

    return slices


class UnsupportedFormat(Exception):
    def __init__(self, input_type):
        self.t = input_type

    def __str__(self):
        return "不支持'{}'模式的转换，请使用为图片地址(path)、PIL.Image(pil)或OpenCV(cv2)模式".format(
            self.t
        )


class MatteMatting:
    def __init__(self, image: Image.Image, mask_image: Image.Image):
        self.image = self.__image_to_opencv(image)
        self.mask_image = self.__image_to_opencv(mask_image)

    @staticmethod
    def __transparent_back(img: Image.Image):
        """
        :param img: 传入图片地址
        :return: 返回替换白色后的透明图
        """
        img = img.convert("RGBA")
        W, H = img.size
        color_0 = (255, 255, 255, 255)  # 要替换的颜色
        for h in range(H):
            for w in range(W):
                dot = (w, h)
                color_1 = img.getpixel(dot)
                if color_1 == color_0:
                    color_1 = color_1[:-1] + (0,)
                    img.putpixel(dot, color_1)
        return img

    def export_image(self, mask_flip=False):
        if mask_flip:
            self.mask_image = cv2.bitwise_not(self.mask_image)  # 黑白翻转
        image = cv2.add(self.image, self.mask_image)
        image = Image.fromarray(
            cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        )  # OpenCV转换成PIL.Image格式
        return self.__transparent_back(image)

    @staticmethod
    def __image_to_opencv(image: Image.Image):
        return cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)
