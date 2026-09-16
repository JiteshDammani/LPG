// supabase/functions/create-user/index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { username, password, first_name, last_name, email } = await req.json();

    if (!username || !password) {
      return new Response(
        JSON.stringify({ success: false, error: "Username and password are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (password.length < 6) {
      return new Response(
        JSON.stringify({ success: false, error: "Password must be at least 6 characters" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: existing } = await supabase
      .from("auth_user")
      .select("id")
      .eq("username", username.trim().toLowerCase())
      .maybeSingle();

    if (existing) {
      return new Response(
        JSON.stringify({ success: false, error: "Username already taken" }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const iterations = 600000;
    const saltBytes = crypto.getRandomValues(new Uint8Array(16));
    const salt = btoa(String.fromCharCode(...saltBytes))
      .replace(/[^a-zA-Z0-9]/g, "")
      .substring(0, 22);

    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      { name: "PBKDF2" },
      false,
      ["deriveBits"],
    );

    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: encoder.encode(salt),
        iterations,
        hash: "SHA-256",
      },
      keyMaterial,
      256,
    );

    const hashBase64 = btoa(String.fromCharCode(...new Uint8Array(derivedBits)));
    const djangoHash = `pbkdf2_sha256$${iterations}$${salt}$${hashBase64}`;

    const now = new Date().toISOString();
    const { data: newUser, error: insertErr } = await supabase
      .from("auth_user")
      .insert({
        username: username.trim().toLowerCase(),
        password: djangoHash,
        first_name: first_name?.trim() || "",
        last_name: last_name?.trim() || "",
        email: email?.trim() || "",
        is_staff: false,
        is_superuser: false,
        is_active: true,
        last_login: null,
        date_joined: now,
      })
      .select("id, username, first_name, last_name, email, is_staff, is_superuser, is_active")
      .single();

    if (insertErr) throw insertErr;

    return new Response(
      JSON.stringify({ success: true, user: newUser }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err: any) {
    console.error("create-user error:", err);
    return new Response(
      JSON.stringify({ success: false, error: err.message || "Server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});