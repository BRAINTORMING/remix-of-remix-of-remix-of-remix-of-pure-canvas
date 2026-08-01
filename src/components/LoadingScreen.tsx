import logo from "@/assets/logo-small-black.svg";

/**
 * Universal loading screen: white background, no text,
 * just the brand mark spinning horizontally in flat simulated 3D.
 */
export default function LoadingScreen() {
  return (
    <div
      className="min-h-screen w-full flex items-center justify-center"
      style={{ background: "#FFFFFF", perspective: "900px" }}
    >
      <img
        src={logo}
        alt=""
        aria-hidden="true"
        className="w-24 h-24 select-none"
        style={{
          transformStyle: "preserve-3d",
          animation: "logo-spin-y 2.2s linear infinite",
        }}
      />
    </div>
  );
}
