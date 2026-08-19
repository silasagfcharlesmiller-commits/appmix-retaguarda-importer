import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "APP MIX | Central de automacao",
  description: "Gestao segura de lotes e automacoes fiscais.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
