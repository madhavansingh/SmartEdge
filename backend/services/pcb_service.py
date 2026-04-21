import os
import torch
import torch.nn as nn
import torchvision.models as models
import torchvision.transforms as transforms
import logging
from typing import Dict, Any
import PIL.Image

logger = logging.getLogger(__name__)

# Defect class mapping
DEFECT_CLASSES = [
    'open circuit', # 0
    'short',        # 1
    'mousebite',    # 2
    'spur',         # 3
    'copper',       # 4
    'pin-hole'      # 5
]

class PCBDefectClassifier(nn.Module):
    def __init__(self, num_classes=6, pretrained=False):
        super(PCBDefectClassifier, self).__init__()
        self.backbone = models.resnet18(pretrained=pretrained)
        num_features = self.backbone.fc.in_features
        self.backbone.fc = nn.Linear(num_features, num_classes)
        self.sigmoid = nn.Sigmoid()

    def forward(self, x):
        x = self.backbone(x)
        x = self.sigmoid(x)
        return x

class PCBService:
    _instance = None
    _model = None
    _device = None
    _transform = None

    def __new__(cls, *args, **kwargs):
        if not cls._instance:
            cls._instance = super(PCBService, cls).__new__(cls, *args, **kwargs)
        return cls._instance

    def __init__(self, model_path: str = "models/best_model.pth"):
        if not hasattr(self, 'initialized'):
            self.model_path = model_path
            self._load_model()
            self.initialized = True

    def _load_model(self):
        try:
            self._device = torch.device('cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu')
            self._model = PCBDefectClassifier(num_classes=len(DEFECT_CLASSES), pretrained=False)
            
            if os.path.exists(self.model_path):
                self._model.load_state_dict(torch.load(self.model_path, map_location=self._device))
                logger.info("PCB model loaded successfully.")
            else:
                logger.warning(f"PCB Model file {self.model_path} not found. Using random weights.")
                
            self._model = self._model.to(self._device)
            self._model.eval()
            
            self._transform = transforms.Compose([
                transforms.ToTensor(),
                transforms.Normalize(mean=[0.485, 0.456, 0.406],
                                     std=[0.229, 0.224, 0.225])
            ])
        except Exception as e:
            logger.error(f"Failed to load PCB model: {str(e)}")
            self._model = None

    def predict(self, image: PIL.Image.Image) -> Dict[str, Any]:
        if self._model is None:
            return self._build_error_response("Model is not loaded.")
            
        if image is None:
            return self._build_error_response("Empty input image.")
            
        try:
            input_tensor = self._transform(image).unsqueeze(0).to(self._device)
            
            with torch.no_grad():
                outputs = self._model(input_tensor)
                probabilities = outputs.squeeze(0).cpu().numpy()
                
            defects = []
            max_confidence = 0.0
            
            for i, prob in enumerate(probabilities):
                conf = float(prob)
                # Lower initial threshold for extraction, fail-safe logic handles the rest
                if conf >= 0.1:
                    defects.append({
                        "type": DEFECT_CLASSES[i],
                        "confidence": round(conf, 2),
                        "bbox": [] # ResNet classifier does not provide bboxes
                    })
                    if conf > max_confidence:
                        max_confidence = conf

            # Filter defects using the 0.5 fail-safe logic mentioned in the prompt
            confident_defects = [d for d in defects if d["confidence"] >= 0.5]

            if len(confident_defects) == 0:
                if len(defects) > 0 and max_confidence >= 0.2:
                    status = "UNCERTAIN"
                    message = "Possible minor defects detected, but confidence is low."
                    # We can still pass the low confidence defects for uncertain state
                    final_defects = defects
                else:
                    status = "PASS"
                    message = "No defects detected."
                    final_defects = []
            else:
                status = "FAIL"
                types_str = ", ".join(list(set([d["type"] for d in confident_defects])))
                message = f"Detected defects: {types_str}"
                final_defects = confident_defects

            response = {
                "product_type": "PCB",
                "status": status,
                "defects": final_defects,
                "confidence": round(max_confidence, 2) if max_confidence > 0 else 1.0,
                "message": message
            }
            
            return response
            
        except Exception as e:
            logger.error(f"Prediction error: {str(e)}")
            return self._build_error_response(f"Inference failed: {str(e)}")

    def _build_error_response(self, message: str) -> Dict[str, Any]:
        logger.error(message)
        return {
            "product_type": "PCB",
            "status": "UNCERTAIN",
            "defects": [],
            "confidence": 0.0,
            "message": "Unable to confidently analyze"
        }

pcb_service = PCBService()
