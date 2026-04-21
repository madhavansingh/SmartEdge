"""
PCB Defect Detection - Dataset Utilities
"""
from pathlib import Path
import cv2
import numpy as np

# Defect class mapping
DEFECT_CLASSES = {
    1: 'open',
    2: 'short',
    3: 'mousebite',
    4: 'spur',
    5: 'copper',
    6: 'pin-hole'
}

DEFECT_COLORS = {
    1: (255, 50, 50),     # open - RED
    2: (50, 255, 50),     # short - GREEN  
    3: (50, 150, 255),    # mousebite - BLUE
    4: (255, 220, 50),    # spur - YELLOW
    5: (255, 50, 255),    # copper - MAGENTA
    6: (50, 255, 255)     # pin-hole - CYAN
}

def parse_annotation(anno_file):
    """Parse annotation file with space-separated format"""
    defects = []
    if not anno_file.exists():
        return defects
    
    try:
        with open(anno_file, 'r') as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) >= 5:
                    defects.append({
                        'x1': int(parts[0]),
                        'y1': int(parts[1]),
                        'x2': int(parts[2]),
                        'y2': int(parts[3]),
                        'type': int(parts[4])
                    })
    except Exception as e:
        print(f"Error parsing {anno_file.name}: {e}")
    return defects

def load_pcb_sample(test_entry, dataset_path):
    """Load test image, template, and annotation paths"""
    parts = test_entry.split()
    img_rel_path = parts[0]
    anno_rel_path = parts[1]
    
    image_id = Path(img_rel_path).stem
    img_dir = Path(img_rel_path).parent
    
    test_img_path = dataset_path / 'PCBData' / img_dir / f"{image_id}_test.jpg"
    temp_img_path = dataset_path / 'PCBData' / img_dir / f"{image_id}_temp.jpg"
    anno_path = dataset_path / 'PCBData' / anno_rel_path
    
    return test_img_path, temp_img_path, anno_path
