// supabase/functions/verify-password/index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function verifyDjangoPassword(
  plainPassword: string,
  encodedHash: string
): Promise<boolean> {
  try {
    const parts = encodedHash.split("$");

    // Plain text password (not hashed) — direct compare
    if (parts.length < 4) {
      return encodedHash === plainPassword;
    }

    const [algorithm, iterationsStr, salt, storedHash] = parts;

    if (algorithm !== "pbkdf2_sha256") {
      // Unsupported algorithm — fall back to direct compare
      return encodedHash === plainPassword;
    }

    const iterations = parseInt(iterationsStr, 10);

    // Import the plain password as a CryptoKey
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(plainPassword),
      { name: "PBKDF2" },
      false,
      ["deriveBits"]
    );

    // Derive bits using same params as Django
    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: new TextEncoder().encode(salt),
        iterations,
        hash: "SHA-256",
      },
      keyMaterial,
      256 // 32 bytes
    );

    // Convert to base64 (Django uses standard base64)
    const derivedBase64 = btoa(
      String.fromCharCode(...new Uint8Array(derivedBits))
    );

    // Constant-time comparison to prevent timing attacks
    const a = new TextEncoder().encode(derivedBase64);
    const b = new TextEncoder().encode(storedHash);

    if (a.length !== b.length) return false;

    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a[i] ^ b[i];
    }

    return diff === 0;
  } catch (err) {
    console.error("Password verification error:", err);
    return false;
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { username, password } = await req.json();

    if (!username || !password) {
      return new Response(
        JSON.stringify({ success: false, error: "Username and password are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Use service role key to bypass RLS and read auth_user
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Fetch user by username
    const { data: user, error } = await supabase
      .from("auth_user")
      .select("id, username, first_name, last_name, email, is_staff, is_superuser, is_active, password")
      .eq("username", username.trim())
      .eq("is_active", true)
      .single();

    if (error || !user) {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid username or password" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Verify password
    const isValid = await verifyDjangoPassword(password, user.password);

    if (!isValid) {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid username or password" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Return user without password
    const { password: _pwd, ...safeUser } = user;

    return new Response(
      JSON.stringify({ success: true, user: safeUser }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: err?.message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
