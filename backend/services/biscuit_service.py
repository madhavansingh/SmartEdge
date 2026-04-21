import logging
from typing import Dict, Any
import PIL.Image
import cv2
import numpy as np

logger = logging.getLogger(__name__)

class BiscuitService:
    _instance = None

    def __new__(cls, *args, **kwargs):
        if not cls._instance:
            cls._instance = super(BiscuitService, cls).__new__(cls, *args, **kwargs)
        return cls._instance

    def __init__(self):
        if not hasattr(self, 'initialized'):
            self.initialized = True
            logger.info("Biscuit CV logic initialized.")

    def predict(self, image: PIL.Image.Image) -> Dict[str, Any]:
        if image is None:
            return self._build_error_response("Empty input image.")
            
        try:
            # 1. Preprocessing & Object Extraction
            img_array = np.array(image.convert('RGB'))
            gray = cv2.cvtColor(img_array, cv2.COLOR_RGB2GRAY)
            hsv = cv2.cvtColor(img_array, cv2.COLOR_RGB2HSV)
            
            # Blur to reduce noise
            blurred = cv2.GaussianBlur(gray, (7, 7), 0)
            
            # Otsu's thresholding for object segmentation
            _, thresh = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
            
            # Clean up mask
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
            thresh = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)
            
            # Find contours
            contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            
            # Filter contours by size
            height, width = gray.shape
            min_area = (height * width) * 0.05
            valid_contours = [c for c in contours if cv2.contourArea(c) > min_area]

            # 2. Presence Check
            if len(valid_contours) == 0:
                return {
                    "product_type": "Biscuit",
                    "status": "UNCERTAIN",
                    "defects": [],
                    "confidence": 0.0,
                    "message": "No significant objects found in view"
                }
                
            # Assume the largest valid contour is the primary object
            largest_contour = max(valid_contours, key=cv2.contourArea)
            
            # Create a mask strictly for the object
            object_mask = np.zeros_like(gray)
            cv2.drawContours(object_mask, [largest_contour], -1, 255, -1)
            
            # 3. Color Detection (Validation)
            # Define brown/light-yellow range in HSV
            lower_color = np.array([5, 20, 20])
            upper_color = np.array([45, 255, 255])
            color_mask = cv2.inRange(hsv, lower_color, upper_color)
            
            # Intersection of object mask and color mask
            valid_color_pixels = cv2.bitwise_and(object_mask, color_mask)
            total_object_pixels = cv2.countNonZero(object_mask)
            
            if total_object_pixels == 0:
                color_score = 0.0
            else:
                color_score = cv2.countNonZero(valid_color_pixels) / total_object_pixels
                
            # 4. Texture Detection (Validation)
            # Compute Laplacian variance inside the mask
            laplacian = cv2.Laplacian(gray, cv2.CV_64F)
            mean_lap, stddev_lap = cv2.meanStdDev(laplacian, mask=object_mask)
            texture_variance = stddev_lap[0][0] ** 2
            
            # Assume a completely smooth object has variance < 5, grainy biscuit > 20
            texture_score = min(1.0, texture_variance / 20.0)
            
            # 5. Overall Confidence Match
            # Combine color and texture to determine if it's actually a biscuit
            overall_match = (color_score * 0.6) + (texture_score * 0.4)
            
            # 6. Edge Break Logic (Defects)
            hull = cv2.convexHull(largest_contour, returnPoints=False)
            broken_edges = 0
            defect_points = []
            
            if hull is not None and len(hull) > 3:
                try:
                    convex_defects = cv2.convexityDefects(largest_contour, hull)
                    if convex_defects is not None:
                        bounding_rect = cv2.boundingRect(largest_contour)
                        max_dim = max(bounding_rect[2], bounding_rect[3])
                        
                        for i in range(convex_defects.shape[0]):
                            s, e, f, d = convex_defects[i, 0]
                            depth = d / 256.0
                            
                            # If depth of defect is > 8% of max dimension, consider it a break
                            if depth > (max_dim * 0.08):
                                broken_edges += 1
                                defect_points.append(tuple(largest_contour[f][0]))
                except Exception as e:
                    logger.warning(f"Failed to calculate convexity defects: {e}")
                    
            # 7. Final Logic
            defects = []
            if broken_edges > 0:
                defects.append({
                    "type": "Broken Edge", 
                    "confidence": min(0.95, 0.70 + (broken_edges * 0.10))
                })
                
            if overall_match < 0.45:
                status = "UNCERTAIN"
                message = "Input does not match expected biscuit color or texture"
                confidence = overall_match
            else:
                if len(defects) > 0:
                    status = "FAIL"
                    confidence = max(d["confidence"] for d in defects)
                    types_str = ", ".join([d["type"] for d in defects])
                    message = f"Detected {types_str}"
                else:
                    status = "PASS"
                    confidence = overall_match
                    message = "No defects detected"

            # 8. Draw Overlay
            overlay_img = img_array.copy()
            # Draw contour
            cv2.drawContours(overlay_img, [largest_contour], -1, (255, 191, 0), 2)
            
            # Highlight breaks
            for pt in defect_points:
                cv2.circle(overlay_img, pt, 8, (255, 0, 0), -1)

            import base64
            from io import BytesIO
            
            annotated_pil = PIL.Image.fromarray(overlay_img)
            buffer = BytesIO()
            annotated_pil.save(buffer, format="JPEG", quality=85)
            encoded_img = base64.b64encode(buffer.getvalue()).decode("utf-8")

            response = {
                "product_type": "Biscuit",
                "status": status,
                "defects": defects,
                "confidence": round(float(confidence), 2),
                "message": message,
                "annotated_image": encoded_img
            }
            
            return response
            
        except Exception as e:
            logger.error(f"Prediction error: {str(e)}")
            return self._build_error_response(f"Inference failed: {str(e)}")

    def _build_error_response(self, message: str) -> Dict[str, Any]:
        logger.error(message)
        return {
            "product_type": "Biscuit",
            "status": "UNCERTAIN",
            "defects": [],
            "confidence": 0.0,
            "message": "Unable to confidently analyze"
        }

biscuit_service = BiscuitService()
