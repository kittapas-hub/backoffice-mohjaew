import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Booking/payment URLs contain bearer capabilities. Do not forward them as
  // Referer values if a future page adds an external asset or link.
  async headers() {
    return [
      {
        source: "/booking/success",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
      {
        source: "/pay/:path*",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
  },
};

export default nextConfig;
