import os
import logging
from typing import Dict, Any
import PIL.Image
from ultralytics import YOLO

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class AutomotiveService:
    _instance = None
    _model = None

    def __new__(cls, *args, **kwargs):
        if not cls._instance:
            cls._instance = super(AutomotiveService, cls).__new__(cls, *args, **kwargs)
        return cls._instance

    def __init__(self, model_path: str = "models/yolov8_automotive.pt"):
        # Ensure __init__ is only executed once
        if not hasattr(self, 'initialized'):
            self.model_path = model_path
            self._load_model()
            self.initialized = True

    def _load_model(self):
        """Loads the YOLOv8 model safely."""
        try:
            if not os.path.exists(self.model_path):
                logger.warning(f"Model file not found at {self.model_path}. Please check path.")
                self._model = None
                return
            
            logger.info(f"Loading YOLOv8 model from {self.model_path}...")
            self._model = YOLO(self.model_path)
            logger.info("YOLOv8 automotive model loaded successfully.")
        except Exception as e:
            logger.error(f"Failed to load YOLOv8 model: {str(e)}")
            self._model = None

    def predict(self, image: PIL.Image.Image) -> Dict[str, Any]:
        """
        Runs inference on the provided image and returns a standardized response.
        """
        if self._model is None:
            return self._build_error_response("Model is not loaded.")
            
        if image is None:
            return self._build_error_response("Empty input image.")
            
        try:
            # YOLO accepts PIL images directly
            # Run inference (setting verbose=False prevents ultralytics from spamming console)
            results = self._model.predict(source=image, verbose=False)
            
            defects = []
            max_confidence = 0.0
            
            # Extract detections from the first (and only) image result
            if len(results) > 0:
                result = results[0]
                # Each detection is in result.boxes
                if result.boxes is not None:
                    for box in result.boxes:
                        cls_id = int(box.cls[0].item())
                        conf = float(box.conf[0].item())
                        # YOLO boxes are in xywh format (or xyxy), ultralytics provides xywh
                        x, y, w, h = box.xywh[0].tolist()
                        class_name = result.names[cls_id]
                        
                        defects.append({
                            "type": class_name,
                            "confidence": round(conf, 2),
                            "bbox": [round(x, 2), round(y, 2), round(w, 2), round(h, 2)]
                        })
                        
                        if conf > max_confidence:
                            max_confidence = conf

            # Determine status and message
            if len(defects) == 0:
                status = "PASS"
                message = "No defects detected."
            else:
                if max_confidence < 0.5:
                    status = "UNCERTAIN"
                    message = "Possible minor defects detected, but confidence is low."
                else:
                    status = "FAIL"
                    types_str = ", ".join(list(set([d["type"] for d in defects])))
                    message = f"Detected defects: {types_str}"

            response = {
                "product_type": "Automotive",
                "status": status,
                "defects": defects,
                "confidence": round(max_confidence, 2) if max_confidence > 0 else 1.0,
                "message": message
            }
            
            logger.info(f"Prediction successful: {status} with {len(defects)} defects.")
            return response
            
        except Exception as e:
            logger.error(f"Prediction error: {str(e)}")
            return self._build_error_response(f"Inference failed: {str(e)}")

    def _build_error_response(self, message: str) -> Dict[str, Any]:
        logger.error(message)
        return {
            "product_type": "Automotive",
            "status": "UNCERTAIN",
            "defects": [],
            "confidence": 0.0,
            "message": "Unable to confidently analyze"
        }

# Instantiate a global service instance for simple dependency injection
automotive_service = AutomotiveService()
