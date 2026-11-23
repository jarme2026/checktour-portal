// =====================================================
// CHECKTOUR UNIFIED WORKER
// One Worker for the portal + Upholstery (/up) + Board (/bo) + DUX (/dux)
//
// Each checklist uses its own Durable Object instance
// (idFromName("up" | "bo" | "dux")), so data stays separate.
//
// Responsibilities:
// - persistent shared checklist state (Durable Object)
// - multi-device progress synchronization
// - per-item checker attribution
// - notes / quantities
// - final CSV report by email
// =====================================================

const PROJECTS = {
  up: {
    from: "Check List Tour <onboarding@resend.dev>",
    subject: "Upholstery — Checklist complete",
    filename: "upholstery-complete.csv"
  },
  bo: {
    from: "Check List Tour <onboarding@resend.dev>",
    subject: "Board — Checklist complete",
    filename: "board-complete.csv"
  },
  dux: {
    from: "DUX Scan <onboarding@resend.dev>",
    subject: "DUX Scan — Checklist complete",
    filename: "dux-scan-complete.csv"
  }
};

const PORTAL_ETA_KEYS = ["upholstery", "board", "dux"];

function normalizeCheckerName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 50);
}

export class ChecklistState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.project = null;
  }

  async getProjectConfig() {
    if (!this.project) {
      this.project =
        (await this.state.storage.get("project")) || "up";
    }
    return PROJECTS[this.project] || PROJECTS.up;
  }

  // Date the list was fully checked (ISO string), or null.
  // Set when the list becomes complete, cleared when it is no longer complete,
  // when a new sheet is uploaded or when progress is reset.
  async updateReceived() {
    const complete =
      await this.isFullyComplete();

    const current =
      await this.state.storage.get("receivedAt");

    if (complete && !current) {
      await this.state.storage.put(
        "receivedAt",
        new Date().toISOString()
      );
    }
    else if (!complete && current) {
      await this.state.storage.delete("receivedAt");
    }

    return complete;
  }

  async getDataset() {
    return (
      await this.state.storage.get(
        "dataset"
      )
    ) || null;
  }

  async getAllTicks() {
    return (
      await this.state.storage.get(
        "ticks"
      )
    ) || {};
  }

  async getAllNotes() {
    return (
      await this.state.storage.get(
        "notes"
      )
    ) || {};
  }


  async getAllCheckedBy() {
    return (
      await this.state.storage.get(
        "checkedByRows"
      )
    ) || {};
  }


  parseExpectedQty(
    row,
    qtyColIndex
  ) {
    if (
      qtyColIndex == null ||
      qtyColIndex < 0
    ) {
      return 1;
    }

    const raw =
      row[qtyColIndex];

    if (
      raw === undefined ||
      raw === null ||
      String(raw).trim() === ""
    ) {
      return 1;
    }

    const normalized =
      String(raw)
        .trim()
        .replace(/\./g, "")
        .replace(",", ".")
        .replace(
          /[^0-9.\-]/g,
          ""
        );

    const n =
      Math.round(
        Math.abs(
          parseFloat(
            normalized
          )
        )
      );

    return (
      Number.isFinite(n) &&
      n > 0
    )
      ? n
      : 1;
  }

  rowKey(row) {
    const str =
      row
        .map(
          c =>
            String(
              c ?? ""
            )
              .trim()
              .toLowerCase()
        )
        .join("|");

    let h = 0;

    for (
      let i = 0;
      i < str.length;
      i++
    ) {
      h =
        (
          Math.imul(
            31,
            h
          )
          +
          str.charCodeAt(i)
        )
        |
        0;
    }

    return (
      "r"
      +
      (h >>> 0)
        .toString(36)
    );
  }

  // Rows done (qty reached or noted) out of total rows.
  async getProgress() {
    const dataset =
      await this.getDataset();

    if (
      !dataset ||
      !dataset.rows ||
      !dataset.rows.length
    ) {
      return { done: 0, total: 0 };
    }

    const ticks =
      await this.getAllTicks();

    const notes =
      await this.getAllNotes();

    const seen = {};
    let done = 0;

    for (const row of dataset.rows) {
      const base = this.rowKey(row);
      seen[base] = (seen[base] || 0) + 1;
      const key = seen[base] > 1 ? base + "d" + seen[base] : base;

      const expected =
        this.parseExpectedQty(row, dataset.qtyColIndex);

      const qty =
        ticks[key] ? (ticks[key].qty || 0) : 0;

      const note =
        String(notes[key] || "").trim();

      if (qty >= expected || note) done++;
    }

    return { done, total: dataset.rows.length };
  }

  async isFullyComplete() {
    const dataset =
      await this.getDataset();

    if (
      !dataset ||
      !dataset.rows ||
      !dataset.rows.length
    ) {
      return false;
    }

    const ticks =
      await this.getAllTicks();

    const notes =
      await this.getAllNotes();

    const seen = {};

    for (
      const row
      of
      dataset.rows
    ) {
      const base =
        this.rowKey(
          row
        );

      seen[base] =
        (seen[base] || 0)
        +
        1;

      const key =
        seen[base] > 1
          ? base
            +
            "d"
            +
            seen[base]
          : base;

      const expected =
        this.parseExpectedQty(
          row,
          dataset.qtyColIndex
        );

      const done =
        ticks[key]
          ? (
              ticks[key].qty
              ||
              0
            )
          : 0;

      const note =
        String(
          notes[key]
          ||
          ""
        ).trim();

      if (
        done < expected &&
        !note
      ) {
        return false;
      }
    }

    return true;
  }

  async buildCsv() {
    const dataset =
      await this.getDataset();

    const ticks =
      await this.getAllTicks();

    const notes =
      await this.getAllNotes();

    const checkedByRows =
      await this.getAllCheckedBy();

    if (!dataset) {
      return "";
    }

    const escape =
      value => {
        const s =
          String(
            value ?? ""
          );

        return /[",\n]/.test(s)
          ? '"'
            +
            s.replace(
              /"/g,
              '""'
            )
            +
            '"'
          : s;
      };

    const seen = {};
    const lines = [];

    lines.push(
      [
        ...dataset.headers,
        "Status",
        "Notes",
        "Checked By"
      ]
        .map(
          escape
        )
        .join(",")
    );

    dataset.rows.forEach(
      row => {
        const base =
          this.rowKey(
            row
          );

        seen[base] =
          (seen[base] || 0)
          +
          1;

        const key =
          seen[base] > 1
            ? base
              +
              "d"
              +
              seen[base]
            : base;

        const expected =
          this.parseExpectedQty(
            row,
            dataset.qtyColIndex
          );

        const tickState =
          ticks[key];

        const done =
          tickState
            ? (
                tickState.qty
                ||
                0
              )
            : 0;

        const note =
          String(
            notes[key]
            ||
            ""
          ).trim();

        let status;

        if (
          done >= expected
        ) {
          status =
            "Done";
        }
        else if (
          note
        ) {
          status =
            "Not available / noted";
        }
        else if (
          done > 0
        ) {
          status =
            `Partial (${done}/${expected})`;
        }
        else {
          status =
            "Not done";
        }

        lines.push(
          [
            ...row,
            status,
            note,
            checkedByRows[key] || ""
          ]
            .map(
              escape
            )
            .join(",")
        );
      }
    );

    return lines.join(
      "\r\n"
    );
  }

  async getResendApiKey() {
    const binding =
      this.env.RESEND_API_KEY;

    if (!binding) {
      return null;
    }

    if (
      typeof binding.get ===
      "function"
    ) {
      return await binding.get();
    }

    if (
      typeof binding ===
      "string"
    ) {
      return binding;
    }

    return null;
  }

  async hasShowroomOrOwnStock() {
    const dataset =
      await this.getDataset();

    if (
      !dataset ||
      !dataset.headers ||
      !dataset.rows
    ) {
      return false;
    }

    const warehouseColIndex =
      dataset.headers.findIndex(
        h => /warehouse/i.test(String(h ?? ""))
      );

    if (warehouseColIndex < 0) {
      return false;
    }

    return dataset.rows.some(row => {
      const value =
        String(row[warehouseColIndex] ?? "")
          .toLowerCase();

      return (
        value.includes("show") ||
        value.includes("own")
      );
    });
  }

  async sendReportEmail(
    checkedBy
  ) {
    const csv =
      await this.buildCsv();

    const recipients =
      (
        this.env.REPORT_RECIPIENTS
        ||
        ""
      )
        .split(",")
        .map(
          s =>
            s.trim()
        )
        .filter(
          Boolean
        );

    if (
      !recipients.length
    ) {
      return {
        ok:
          false,
        error:
          "No REPORT_RECIPIENTS configured"
      };
    }

    const apiKey =
      await this.getResendApiKey();

    if (
      !apiKey
    ) {
      return {
        ok:
          false,
        error:
          "No RESEND_API_KEY configured"
      };
    }

    const bytes =
      new TextEncoder()
        .encode(
          csv
        );

    let binary = "";

    for (
      let i = 0;
      i < bytes.length;
      i++
    ) {
      binary +=
        String.fromCharCode(
          bytes[i]
        );
    }

    const base64 =
      btoa(
        binary
      );

    const safeChecker =
      String(
        checkedBy
        ||
        ""
      ).trim();

    const subjectSuffix =
      safeChecker
        ? " — checked by " + safeChecker
        : "";

    const subjectWarehouseTag =
      (await this.hasShowroomOrOwnStock())
        ? " — Showroom/Own stock items"
        : "";

    const textCheckerLine =
      safeChecker
        ? "\n\nChecked by: " + safeChecker
        : "";

    const cfg =
      await this.getProjectConfig();

    const res =
      await fetch(
        "https://api.resend.com/emails",
        {
          method:
            "POST",

          headers: {
            Authorization:
              "Bearer "
              +
              apiKey,

            "content-type":
              "application/json"
          },

          body:
            JSON.stringify({
              from:
                cfg.from,

              to:
                recipients,

              subject:
                cfg.subject
                +
                subjectWarehouseTag
                +
                subjectSuffix,

              text:
                "The checklist has been fully checked off."
                +
                textCheckerLine
                +
                "\n\nThe updated sheet is attached as a CSV.",

              attachments: [
                {
                  filename:
                    cfg.filename,

                  content:
                    base64
                }
              ]
            })
        }
      );

    if (
      !res.ok
    ) {
      const errText =
        await res
          .text()
          .catch(
            () => ""
          );

      return {
        ok:
          false,

        error:
          "Resend API error ("
          +
          res.status
          +
          "): "
          +
          errText
      };
    }

    return {
      ok:
        true
    };
  }

  async fetch(
    request
  ) {
    const url =
      new URL(
        request.url
      );

    const projectHeader =
      request.headers.get("x-project");

    if (
      projectHeader &&
      PROJECTS[projectHeader] &&
      this.project !== projectHeader
    ) {
      this.project = projectHeader;
      await this.state.storage.put("project", projectHeader);
    }

    try {

      if (
        url.pathname ===
          "/state"
        &&
        request.method ===
          "GET"
      ) {
        const dataset =
          await this.getDataset();

        const ticks =
          await this.getAllTicks();

        const notes =
          await this.getAllNotes();

        const checkedByRows =
          await this.getAllCheckedBy();

        return json({
          headers:
            dataset
              ? dataset.headers
              : [],

          rows:
            dataset
              ? dataset.rows
              : [],

          tickColIndex:
            dataset
              ? dataset.tickColIndex
              : -1,

          qtyColIndex:
            dataset
              ? dataset.qtyColIndex
              : -1,

          ticks,

          notes,

          checkedByRows
        });
      }

      if (
        url.pathname ===
          "/received"
        &&
        request.method ===
          "GET"
      ) {
        const progress =
          await this.getProgress();

        return json({
          receivedAt:
            (await this.state.storage.get("receivedAt")) || null,

          done:
            progress.done,

          total:
            progress.total
        });
      }

      if (
        url.pathname ===
          "/ticks"
        &&
        request.method ===
          "GET"
      ) {
        const ticks =
          await this.getAllTicks();

        const notes =
          await this.getAllNotes();

        const checkedByRows =
          await this.getAllCheckedBy();

        return json({
          ticks,
          notes,
          checkedByRows
        });
      }

      if (
        url.pathname ===
          "/dataset"
        &&
        request.method ===
          "POST"
      ) {
        const body =
          await request.json();

        await this.state.storage.put(
          "dataset",
          {
            headers:
              body.headers,

            rows:
              body.rows,

            tickColIndex:
              body.tickColIndex,

            qtyColIndex:
              body.qtyColIndex
          }
        );

        await this.state.storage.put(
          "checkedByRows",
          {}
        );

        await this.state.storage.put(
          "reportSent",
          false
        );

        await this.state.storage.delete(
          "receivedAt"
        );

        return json({
          ok:
            true
        });
      }

      if (
        url.pathname ===
          "/tick"
        &&
        request.method ===
          "POST"
      ) {
        const body =
          await request.json();

        const ticks =
          await this.getAllTicks();

        const current =
          ticks[body.key]
          ||
          {
            qty:
              0,

            date:
              ""
          };

        const expected =
          typeof body.expected ===
            "number"
          &&
          body.expected > 0
            ? body.expected
            : 1;

        let newQty;

        if (
          body.mode ===
          "delta"
        ) {
          newQty =
            current.qty
            +
            Number(
              body.value
              ||
              0
            );
        }
        else {
          newQty =
            Number(
              body.value
              ||
              0
            );
        }

        if (
          newQty < 0
        ) {
          newQty =
            0;
        }

        if (
          newQty > expected
        ) {
          newQty =
            expected;
        }

        const newDate =
          newQty > 0
            ? new Date()
                .toLocaleDateString(
                  "en-US"
                )
            : "";

        ticks[body.key] = {
          qty:
            newQty,

          date:
            newDate
        };

        await this.state.storage.put(
          "ticks",
          ticks
        );

        const checkedByRows =
          await this.getAllCheckedBy();

        const checkerName =
          normalizeCheckerName(
            body.checkedBy
          );

        const previousQty =
          Number(
            current.qty || 0
          );

        const isComplete =
          newQty >= expected;

        const madePositiveProgress =
          newQty > previousQty;

        if (
          madePositiveProgress
          &&
          checkerName.length >= 2
        ) {
          const existingNames =
            String(
              checkedByRows[body.key] || ""
            )
              .split(",")
              .map(
                name => name.trim()
              )
              .filter(Boolean);

          if (
            !existingNames.includes(
              checkerName
            )
          ) {
            existingNames.push(
              checkerName
            );
          }

          checkedByRows[body.key] =
            existingNames.join(", ");
        }

        // If all progress for the row is removed, clear its attribution.
        if (
          newQty === 0
        ) {
          const notesNow =
            await this.getAllNotes();

          const noteNow =
            String(
              notesNow[body.key] || ""
            ).trim();

          if (
            !noteNow
          ) {
            delete checkedByRows[
              body.key
            ];
          }
        }

        await this.state.storage.put(
          "checkedByRows",
          checkedByRows
        );

        const allComplete =
          await this.updateReceived();

        return json({
          ok:
            true,

          qty:
            newQty,

          date:
            newDate,

          ticks,

          allComplete
        });
      }

      if (
        url.pathname ===
          "/note"
        &&
        request.method ===
          "POST"
      ) {
        const body =
          await request.json();

        const notes =
          await this.getAllNotes();

        const previousNote =
          String(
            notes[body.key]
            ||
            ""
          );

        const cleanNote =
          String(
            body.note
            ||
            ""
          ).trim();

        if (
          cleanNote
        ) {
          notes[body.key] =
            cleanNote;
        }
        else {
          delete notes[
            body.key
          ];
        }

        await this.state.storage.put(
          "notes",
          notes
        );

        const checkedByRows =
          await this.getAllCheckedBy();

        const checkerName =
          normalizeCheckerName(
            body.checkedBy
          );

        if (
          cleanNote
          &&
          checkerName.length >= 2
        ) {
          const existingNames =
            String(
              checkedByRows[body.key] || ""
            )
              .split(",")
              .map(
                name => name.trim()
              )
              .filter(Boolean);

          if (
            !existingNames.includes(
              checkerName
            )
          ) {
            existingNames.push(
              checkerName
            );
          }

          checkedByRows[body.key] =
            existingNames.join(", ");
        }

        if (
          !cleanNote
        ) {
          const ticksNow =
            await this.getAllTicks();

          const qtyNow =
            ticksNow[body.key]
              ? Number(
                  ticksNow[body.key].qty || 0
                )
              : 0;

          if (
            qtyNow === 0
          ) {
            delete checkedByRows[
              body.key
            ];
          }
        }

        await this.state.storage.put(
          "checkedByRows",
          checkedByRows
        );

        const allComplete =
          await this.updateReceived();

        return json({
          ok:
            true,

          notes,

          allComplete
        });
      }

      if (
        url.pathname ===
          "/reset"
        &&
        request.method ===
          "POST"
      ) {
        await this.state.storage.put(
          "ticks",
          {}
        );

        await this.state.storage.put(
          "notes",
          {}
        );

        await this.state.storage.put(
          "checkedByRows",
          {}
        );

        await this.state.storage.put(
          "reportSent",
          false
        );

        await this.state.storage.delete(
          "receivedAt"
        );

        return json({
          ok:
            true
        });
      }

      // =================================================
      // SEND REPORT
      //
      // Normal report:
      //   Adrian / Leo / Liviu is REQUIRED.
      //
      // Admin test:
      //   force:true sends with Checked By blank.
      //   It never writes "Test email".
      // =================================================

      if (
        url.pathname ===
          "/send-report"
        &&
        request.method ===
          "POST"
      ) {
        let body = {};

        try {
          body =
            await request.json();
        }
        catch (
          error
        ) {
          body = {};
        }

        const force =
          body.force ===
          true;

        const requestedChecker = normalizeCheckerName(body.checkedBy);
        const checkedBy = force ? '' : requestedChecker;

        if (!force && checkedBy.length < 2) {
          return json(
            { ok: false, error: 'Please enter the name of the person who checked the list.' },
            400
          );
        }

        if (
          !force
        ) {
          const alreadySent =
            await this.state.storage.get(
              "reportSent"
            );

          if (
            alreadySent
          ) {
            return json({
              ok:
                true,

              skipped:
                true,

              reason:
                "already sent"
            });
          }

          const complete =
            await this.isFullyComplete();

          if (
            !complete
          ) {
            return json({
              ok:
                true,

              skipped:
                true,

              reason:
                "not complete"
            });
          }
        }

        const result =
          await this.sendReportEmail(
            checkedBy
          );

        if (
          !result.ok
        ) {
          return json(
            {
              ok:
                false,

              error:
                result.error
            },
            502
          );
        }

        if (
          !force
        ) {
          await this.state.storage.put(
            "reportSent",
            true
          );

          await this.state.storage.put(
            "lastCheckedBy",
            checkedBy
          );
        }

        return json({
          ok:
            true,

          sent:
            true,

          test:
            force,

          checkedBy
        });
      }

      return json(
        {
          error:
            "not found"
        },
        404
      );
    }
    catch (
      err
    ) {
      return json(
        {
          error:
            String(
              err
              &&
              err.message
                ? err.message
                : err
            )
        },
        500
      );
    }
  }
}

function json(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(
      data
    ),
    {
      status,

      headers: {
        "content-type":
          "application/json"
      }
    }
  );
}

// =====================================================
// WEB PUSH (no libraries — WebCrypto only)
//
// - VAPID keys are created automatically on first use and kept in
//   the PortalState Durable Object (nothing to configure).
// - Payload encryption: aes128gcm (RFC 8291 / RFC 8188).
// =====================================================

const PUSH_PROJECTS = {
  up:  { name: "Upholstery", path: "/up/",  etaKey: "upholstery" },
  bo:  { name: "Board",      path: "/bo/",  etaKey: "board" },
  dux: { name: "DUX",        path: "/dux/", etaKey: "dux" }
};

const enc = new TextEncoder();

function b64urlEncode(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concatBytes(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8
  );
  return new Uint8Array(bits);
}

async function createVapidKeys() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: b64urlEncode(publicRaw), privateJwk };
}

async function vapidAuthHeader(endpoint, vapid, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64urlEncode(enc.encode(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject
  })));
  const unsigned = header + "." + payload;

  const key = await crypto.subtle.importKey(
    "jwk",
    vapid.privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(unsigned));

  return "vapid t=" + unsigned + "." + b64urlEncode(sig) + ", k=" + vapid.publicKey;
}

// Encrypts `payload` (string) for one subscription. Returns the request body.
async function encryptPushPayload(subscription, payload) {
  const uaPublic = b64urlDecode(subscription.keys.p256dh);
  const authSecret = b64urlDecode(subscription.keys.auth);

  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));

  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256)
  );

  const keyInfo = concatBytes(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const plaintext = concatBytes(enc.encode(payload), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintext));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);

  return concatBytes(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

async function sendPush(subscription, payload, vapid, subject) {
  const body = await encryptPushPayload(subscription, payload);
  return fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuthHeader(subscription.endpoint, vapid, subject),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "high"
    },
    body
  });
}

// =====================================================
// PORTAL STATE (ETA per project + push subscriptions)
// =====================================================

export class PortalState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async getEtas() {
    return (await this.state.storage.get("etas")) || {};
  }

  async getSubs() {
    return (await this.state.storage.get("pushSubs")) || {};
  }

  async getVapid() {
    let vapid = await this.state.storage.get("vapid");
    if (!vapid) {
      vapid = await createVapidKeys();
      await this.state.storage.put("vapid", vapid);
    }
    return vapid;
  }

  vapidSubject() {
    const first = String(this.env.REPORT_RECIPIENTS || "").split(",")[0].trim();
    return first ? "mailto:" + first : "mailto:admin@example.com";
  }

  // Sends "new sheet" to every subscribed device; removes expired ones.
  async notifyNewSheet(project) {
    const subs = await this.getSubs();
    const entries = Object.entries(subs);
    if (!entries.length) return { ok: true, sent: 0, removed: 0 };

    const vapid = await this.getVapid();
    const subject = this.vapidSubject();

    // "Upholstery - 19/11/2026" (ETA date saved in the portal for this list)
    const eta = (await this.getEtas())[project.etaKey];
    const title = eta
      ? project.name + " - " + eta.split("-").reverse().join("/")
      : project.name;
    let sent = 0;
    let removed = 0;

    await Promise.all(entries.map(async ([endpoint, entry]) => {
      const payload = JSON.stringify({
        title,
        body: "A new " + project.name + " list is ready. Tap to open the checklist.",
        url: project.path + (entry.admin ? "?admin=1" : ""),
        tag: "sheet-" + project.name.toLowerCase()
      });
      try {
        const res = await sendPush(entry.subscription, payload, vapid, subject);
        if (res.status === 404 || res.status === 410) {
          delete subs[endpoint];
          removed++;
        } else if (res.ok) {
          sent++;
        }
      } catch (e) {}
    }));

    if (removed) await this.state.storage.put("pushSubs", subs);
    return { ok: true, sent, removed };
  }

  async fetch(request) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/eta" && request.method === "GET") {
        return json({ etas: await this.getEtas() });
      }

      if (url.pathname === "/eta" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const etas = await this.getEtas();

        for (const key of PORTAL_ETA_KEYS) {
          if (!(key in body)) continue;
          const value = String(body[key] ?? "").trim();
          if (value === "") delete etas[key];
          else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) etas[key] = value;
        }

        await this.state.storage.put("etas", etas);
        return json({ ok: true, etas });
      }

      // ---------- push notifications ----------

      if (url.pathname === "/push/key" && request.method === "GET") {
        const vapid = await this.getVapid();
        return json({ publicKey: vapid.publicKey });
      }

      if (url.pathname === "/push/subscribe" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const sub = body.subscription || {};

        if (
          typeof sub.endpoint !== "string" ||
          !sub.endpoint.startsWith("https://") ||
          !sub.keys || !sub.keys.p256dh || !sub.keys.auth
        ) {
          return json({ ok: false, error: "invalid subscription" }, 400);
        }

        const subs = await this.getSubs();
        subs[sub.endpoint] = {
          subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
          admin: body.admin === true,
          created: subs[sub.endpoint] ? subs[sub.endpoint].created : new Date().toISOString()
        };
        await this.state.storage.put("pushSubs", subs);
        return json({ ok: true });
      }

      if (url.pathname === "/push/unsubscribe" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const subs = await this.getSubs();
        delete subs[String(body.endpoint || "")];
        await this.state.storage.put("pushSubs", subs);
        return json({ ok: true });
      }

      // Internal only (blocked from the outside by the main worker)
      if (url.pathname === "/push/notify" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const project = PUSH_PROJECTS[body.project];
        if (!project) return json({ ok: false, error: "unknown project" }, 400);
        return json(await this.notifyNewSheet(project));
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: String(err && err.message ? err.message : err) }, 500);
    }
  }
}

// =====================================================
// MAIN WORKER
//   /api/*          -> PortalState (ETA)
//   /up/api/*       -> ChecklistState "up"
//   /bo/api/*       -> ChecklistState "bo"
//   /dux/api/*      -> ChecklistState "dux"
//   everything else -> static files in ./dist
// =====================================================

function forward(stub, request, url, prefix, extraHeaders) {
  const forwardUrl = new URL(request.url);
  forwardUrl.pathname = url.pathname.slice(prefix.length) || "/";

  const forwardReq = new Request(forwardUrl.toString(), request);
  for (const [k, v] of Object.entries(extraHeaders || {})) forwardReq.headers.set(k, v);

  return stub.fetch(forwardReq);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Checklist APIs: /up/api/..., /bo/api/..., /dux/api/...
    const match = url.pathname.match(/^\/(up|bo|dux)\/api(\/.*)?$/);
    if (match) {
      const project = match[1];
      // Admin confirmed the ETA after uploading a sheet -> notify every subscribed phone
      if (match[2] === "/notify" && request.method === "POST") {
        const portal = env.PORTAL.get(env.PORTAL.idFromName("singleton"));
        return portal.fetch(new Request(url.origin + "/push/notify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project })
        }));
      }

      const stub = env.CHECKLIST.get(env.CHECKLIST.idFromName(project));
      return forward(stub, request, url, "/" + project + "/api", { "x-project": project });
    }

    // Portal API: GET /api/eta also returns the date each list was fully checked
    if (url.pathname === "/api/eta" && request.method === "GET") {
      const portal = env.PORTAL.get(env.PORTAL.idFromName("singleton"));
      const etaRes = await portal.fetch(new Request(url.origin + "/eta"));
      const data = await etaRes.json();

      const map = { upholstery: "up", board: "bo", dux: "dux" };
      data.received = {};
      data.progress = {};

      await Promise.all(
        Object.entries(map).map(async ([key, project]) => {
          try {
            const stub = env.CHECKLIST.get(env.CHECKLIST.idFromName(project));
            const r = await stub.fetch(new Request(url.origin + "/received"));
            const j = await r.json();
            if (j.receivedAt) data.received[key] = j.receivedAt;
            data.progress[key] = { done: j.done || 0, total: j.total || 0 };
          } catch (e) {}
        })
      );

      return json(data);
    }

    // Internal route, never callable from the outside
    if (url.pathname === "/api/push/notify") {
      return json({ error: "not found" }, 404);
    }

    // Portal API: /api/eta (save), /api/push/key|subscribe|unsubscribe
    if (url.pathname.startsWith("/api/")) {
      const stub = env.PORTAL.get(env.PORTAL.idFromName("singleton"));
      return forward(stub, request, url, "/api");
    }

    // Old links without trailing slash: /up -> /up/
    if (/^\/(up|bo|dux)$/.test(url.pathname)) {
      return Response.redirect(url.origin + url.pathname + "/" + url.search, 301);
    }

    return env.ASSETS.fetch(request);
  }
};
