import logo from "@/assets/logo-small-black.svg";

/**
 * Universal loading screen: white background, no text, just the brand mark
 * spinning horizontally with a faked flat-3D extrusion (stacked copies along
 * the Z axis). No shadows, no gradients — flat colors only.
 */
const DEPTH_LAYERS = 16;
const LAYER_STEP = 0.9; // px between stacked copies

export default function LoadingScreen() {
  return (
    <div
      className="min-h-screen w-full flex items-center justify-center"
      style={{ background: "#FFFFFF", perspective: "900px" }}
    >
      <div
        className="relative w-24 h-24 select-none"
        style={{
          transformStyle: "preserve-3d",
          animation: "logo-spin-y 2.6s linear infinite",
        }}
      >
        {Array.from({ length: DEPTH_LAYERS }).map((_, i) => {
          const isFront = i === DEPTH_LAYERS - 1;
          const z = (i - (DEPTH_LAYERS - 1) / 2) * LAYER_STEP;
          return (
            <img
              key={i}
              src={logo}
              alt=""
              aria-hidden="true"
              className="absolute inset-0 w-full h-full"
              style={{
                transform: `translateZ(${z}px)`,
                backfaceVisibility: "visible",
                // Back layers are a flat darker tone to read as extrusion depth.
                filter: isFront ? "none" : "brightness(0.62)",
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
