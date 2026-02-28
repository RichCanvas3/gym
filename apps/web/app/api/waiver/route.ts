import { NextResponse } from "next/server";
import crypto from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type WaiverPayload = {
  accountAddress: string;
  participantName: string;
  participantEmail: string;
  participantDobISO: string; // YYYY-MM-DD
  participantSignature: string;

  isMinor: boolean;
  guardianName?: string;
  guardianEmail?: string;
  guardianSignature?: string;
};

type WaiverRecord = WaiverPayload & {
  id: string;
  createdAtISO: string;
};

const globalForWaivers = globalThis as unknown as {
  __waivers?: Map<string, WaiverRecord>;
};

function waiversStore() {
  if (!globalForWaivers.__waivers) globalForWaivers.__waivers = new Map();
  return globalForWaivers.__waivers;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Partial<WaiverPayload> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const accountAddress = asTrimmedString(body.accountAddress);
  const participantName = asTrimmedString(body.participantName);
  const participantEmail = asTrimmedString(body.participantEmail);
  const participantDobISO = asTrimmedString(body.participantDobISO);
  const participantSignature = asTrimmedString(body.participantSignature);
  const isMinor = body.isMinor === true;

  if (!accountAddress || !participantName || !participantEmail || !participantDobISO || !participantSignature) {
    return NextResponse.json({ error: "Missing required participant fields" }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(participantDobISO)) {
    return NextResponse.json({ error: "participantDobISO must be YYYY-MM-DD" }, { status: 400 });
  }

  const { computedIsMinor } = computeAge(participantDobISO);
  if (computedIsMinor !== isMinor) {
    return NextResponse.json(
      { error: "isMinor does not match date of birth" },
      { status: 400 },
    );
  }

  let guardianName: string | undefined;
  let guardianEmail: string | undefined;
  let guardianSignature: string | undefined;

  if (isMinor) {
    guardianName = asTrimmedString(body.guardianName);
    guardianEmail = asTrimmedString(body.guardianEmail);
    guardianSignature = asTrimmedString(body.guardianSignature);
    if (!guardianName || !guardianEmail || !guardianSignature) {
      return NextResponse.json(
        { error: "Guardian name, email, and signature are required for minors" },
        { status: 400 },
      );
    }
  }

  const id = crypto.randomUUID();
  const createdAtISO = new Date().toISOString();
  const record: WaiverRecord = {
    id,
    createdAtISO,
    accountAddress,
    participantName,
    participantEmail,
    participantDobISO,
    participantSignature,
    isMinor,
    guardianName,
    guardianEmail,
    guardianSignature,
  };

  waiversStore().set(id, record);

  return NextResponse.json({
    id,
    createdAtISO,
    message: "Waiver submitted.",
  });
}

function asTrimmedString(v: unknown) {
  if (typeof v !== "string") return "";
  return v.trim();
}

function computeAge(dobISO: string) {
  const dob = new Date(`${dobISO}T00:00:00Z`);
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return { age, computedIsMinor: age < 18 };
}

