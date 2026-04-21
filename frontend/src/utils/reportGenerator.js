export const generateReport = (defectType) => {
  const typeLower = defectType.toLowerCase();
  
  if (typeLower.includes('open')) {
    return {
      impact: "May cause complete power delivery failure and circuit breaks.",
      recommendation: "Inspect soldering batch and check component alignment."
    };
  }
  
  if (typeLower.includes('short')) {
    return {
      impact: "High risk of thermal runaway or component burnout.",
      recommendation: "Immediate batch quarantine. Check solder paste application."
    };
  }
  
  if (typeLower.includes('mouse') || typeLower.includes('bite')) {
    return {
      impact: "Weakens structural integrity and current capacity.",
      recommendation: "Review routing process and CNC machine calibration."
    };
  }
  
  if (typeLower.includes('spur')) {
    return {
      impact: "Risk of eventual short circuits under thermal expansion.",
      recommendation: "Check etching fluid concentration and timing."
    };
  }
  
  if (typeLower.includes('copper')) {
    return {
      impact: "Potential signal interference and unintended grounding.",
      recommendation: "Clean etching tanks and review wash cycles."
    };
  }

  // Default
  return {
    impact: "Anomaly detected violating manufacturing tolerances.",
    recommendation: "Flag for manual visual inspection by QA."
  };
};
