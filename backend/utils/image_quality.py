import cv2
import numpy as np
from PIL import Image

class ImagePreprocessor:
    def __init__(self):
        # Configuration thresholds
        self.min_blur_var = 15.0  # Reduced threshold for Laplacian variance
        self.min_brightness = 10.0 # Widened range
        self.max_brightness = 250.0 # Widened range
        self.min_resolution = (100, 100)
        self.glare_threshold = 245
        self.max_glare_ratio = 0.05  # Max 5% of pixels can be saturated

    def assess_and_preprocess(self, pil_image: Image.Image, product_type: str) -> tuple:
        """
        Assesses image quality and applies preprocessing.
        Returns: (is_valid, status, message, quality_score, preprocessed_image)
        """
        # 1. Quality Assessment
        img_np = np.array(pil_image.convert('RGB'))
        gray = cv2.cvtColor(img_np, cv2.COLOR_RGB2GRAY)
        
        height, width = gray.shape
        
        generic_msg = "Low image quality, result may be less accurate"

        # Check resolution
        if width < self.min_resolution[0] or height < self.min_resolution[1]:
            return False, "UNCERTAIN", generic_msg, 0, None
            
        # Check brightness
        mean_brightness = np.mean(gray)
        if mean_brightness < self.min_brightness or mean_brightness > self.max_brightness:
            return False, "UNCERTAIN", generic_msg, int((mean_brightness/255)*100), None
            
        # Check blur (Variance of Laplacian)
        laplacian_var = cv2.Laplacian(gray, cv2.CV_64F).var()
        if laplacian_var < self.min_blur_var:
            return False, "UNCERTAIN", generic_msg, int(min(laplacian_var, 100)), None
            
        # Check glare/screen artifacts
        saturated_pixels = np.sum(gray > self.glare_threshold)
        glare_ratio = saturated_pixels / (width * height)
        if glare_ratio > self.max_glare_ratio:
            return False, "UNCERTAIN", generic_msg, 50, None
            
        # Base quality score logic
        quality_score = min(100, int((laplacian_var / 500) * 100))
        quality_score = max(50, quality_score) # Since it passed min_blur

        # 2. Preprocessing
        # Determine target size based on product type
        if product_type.upper() == "PCB":
            target_size = (224, 224)
        elif product_type.upper() == "AUTOMOTIVE":
            target_size = (640, 640)
        else:
            target_size = (512, 512)
            
        # Resize
        resized = cv2.resize(img_np, target_size, interpolation=cv2.INTER_AREA)
        
        # Noise reduction (Gaussian Blur)
        blurred = cv2.GaussianBlur(resized, (3, 3), 0)
        
        # Normalize (Histogram Equalization for better contrast)
        # We apply CLAHE to the L channel of LAB color space to preserve color
        lab = cv2.cvtColor(blurred, cv2.COLOR_RGB2LAB)
        l, a, b = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        cl = clahe.apply(l)
        limg = cv2.merge((cl, a, b))
        normalized = cv2.cvtColor(limg, cv2.COLOR_LAB2RGB)
        
        final_image = Image.fromarray(normalized)
        
        return True, "OK", "Quality check passed", quality_score, final_image

preprocessor = ImagePreprocessor()
