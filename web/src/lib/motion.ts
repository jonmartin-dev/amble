// Material 3 Expressive motion, from androidx compose material3
// tokens/ExpressiveMotionTokens.kt and StandardMotionTokens.kt.
// Material specifies springs as (damping ratio, stiffness) with unit mass;
// Motion takes absolute damping, so damping = ratio * 2 * sqrt(stiffness).

function spring(dampingRatio: number, stiffness: number) {
  return { type: 'spring', stiffness, damping: dampingRatio * 2 * Math.sqrt(stiffness), mass: 1 } as const;
}

/** Expressive scheme: for hero moments and prominent UI. Spatial springs overshoot a little. */
export const expressive = {
  fastSpatial: spring(0.6, 800),
  defaultSpatial: spring(0.8, 380),
  slowSpatial: spring(0.8, 200),
  fastEffects: spring(1, 3800),
  defaultEffects: spring(1, 1600),
  slowEffects: spring(1, 800),
};

/** Standard scheme: for utilitarian, frequently repeated interactions. */
export const standard = {
  fastSpatial: spring(0.9, 1400),
  defaultSpatial: spring(0.9, 700),
  slowSpatial: spring(0.9, 300),
  fastEffects: spring(1, 3800),
  defaultEffects: spring(1, 1600),
  slowEffects: spring(1, 800),
};
