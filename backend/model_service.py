import os
import torch
import torch.nn as nn
import torchvision.models as models
import torchvision.transforms as transforms
from PIL import Image

# Defect class mapping (0-indexed to match model output)
DEFECT_CLASSES = [
    'open circuit', # 0
    'short',        # 1
    'mousebite',    # 2
    'spur',         # 3
    'copper',       # 4
    'pin-hole'      # 5
]

class PCBDefectClassifier(nn.Module):
    """ResNet18-based classifier for multi-label PCB defect detection"""

    def __init__(self, num_classes=6, pretrained=False):
        super(PCBDefectClassifier, self).__init__()
        # Load ResNet18
        self.backbone = models.resnet18(pretrained=pretrained)
        
        # Replace final FC layer for multi-label classification
        num_features = self.backbone.fc.in_features
        self.backbone.fc = nn.Linear(num_features, num_classes)
        
        # Sigmoid for multi-label (not softmax!)
        self.sigmoid = nn.Sigmoid()

    def forward(self, x):
        x = self.backbone(x)
        x = self.sigmoid(x)
        return x


# Global variables to hold the loaded model and state
_model = None
_device = None
_transform = None


def load_model(model_path="models/best_model.pth"):
    """
    Loads the trained PyTorch model only once at startup.
    
    Args:
        model_path (str): Path to the saved .pth model file.
        
    Returns:
        The loaded PyTorch model.
    """
    global _model, _device, _transform
    
    # Return already loaded model to ensure it's only loaded once
    if _model is not None:
        return _model
        
    _device = torch.device('cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu')
    
    # Initialize model architecture
    _model = PCBDefectClassifier(num_classes=len(DEFECT_CLASSES), pretrained=False)
    
    # Load weights if the file exists
    if os.path.exists(model_path):
        _model.load_state_dict(torch.load(model_path, map_location=_device))
    else:
        print(f"Warning: Model file {model_path} not found. Initialized with random weights.")
        
    _model = _model.to(_device)
    _model.eval()
    
    # Define preprocessing to match the training pipeline
    _transform = transforms.Compose([
        transforms.Resize((224, 224)),
        transforms.ToTensor(),
        transforms.Normalize(mean=[0.485, 0.456, 0.406],
                             std=[0.229, 0.224, 0.225])
    ])
    
    return _model


def predict_image(image, threshold=0.5):
    """
    Takes an image input and returns defect predictions.
    
    Args:
        image: A PIL Image object or a string path to an image file.
        threshold (float): Confidence threshold for defect detection (default: 0.5).
        
    Returns:
        dict: A dictionary with the following format:
              {
                "status": "PASS" or "FAIL",
                "defects": [
                  {
                    "type": "open circuit",
                    "confidence": 0.91
                  }
                ]
              }
    """
    global _model, _device, _transform
    
    # Ensure model is loaded
    if _model is None:
        load_model()
        
    # Handle image input
    if isinstance(image, str):
        if not os.path.exists(image):
            raise FileNotFoundError(f"Image not found at path: {image}")
        img = Image.open(image).convert('RGB')
    elif isinstance(image, Image.Image):
        if image.mode != 'RGB':
            img = image.convert('RGB')
        else:
            img = image
    else:
        raise ValueError("Input image must be a PIL Image or a file path")
        
    # Preprocess the image
    input_tensor = _transform(img).unsqueeze(0).to(_device)
    
    # Run inference
    with torch.no_grad():
        outputs = _model(input_tensor)
        probabilities = outputs.squeeze(0).cpu().numpy()
        
    # Format the results based on the threshold
    defects = []
    for i, prob in enumerate(probabilities):
        if prob >= threshold:
            defects.append({
                "type": DEFECT_CLASSES[i],
                "confidence": round(float(prob), 2)
            })
            
    # Determine PASS/FAIL status
    if not defects:
        return {
            "status": "PASS",
            "defects": []
        }
    else:
        return {
            "status": "FAIL",
            "defects": defects
        }
