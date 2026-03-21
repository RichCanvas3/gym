import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { CartProvider } from "@/components/cart/CartProvider";
import { WaiverProvider } from "@/components/waiver/WaiverProvider";
import { ReservationsProvider } from "@/components/reservations/ReservationsProvider";
import { AppHeader } from "@/components/nav/AppHeader";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Erie Rec Center Copilot",
  description: "Next.js + LangChain hosted agent for a fitness + recreation assistant",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <CartProvider>
          <WaiverProvider>
            <ReservationsProvider>
              <AppHeader />
              {children}
            </ReservationsProvider>
          </WaiverProvider>
        </CartProvider>
      </body>
    </html>
  );
}
