// Vercel Serverless Function: Send Alloggiati TXT via Resend
// Path: /api/send-alloggiati-txt.js

/**********************************************
 * RATE LIMITING - In-memory store
 **********************************************/
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 ora in ms
const RATE_LIMIT_MAX = 10; // max 10 invii per IP per ora

function getRateLimitKey(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = forwarded ? forwarded.split(',')[0].trim() : req.socket?.remoteAddress || 'unknown';
  return ip;
}

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimitMap.get(ip);
  
  if (!record) {
    rateLimitMap.set(ip, { count: 1, firstRequest: now });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 };
  }
  
  if (now - record.firstRequest > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { count: 1, firstRequest: now });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 };
  }
  
  record.count++;
  if (record.count > RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0 };
  }
  return { allowed: true, remaining: RATE_LIMIT_MAX - record.count };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // RATE LIMITING CHECK
    const clientIP = getRateLimitKey(req);
    const rateCheck = checkRateLimit(clientIP);
    res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, rateCheck.remaining));
    
    if (!rateCheck.allowed) {
      return res.status(429).json({ 
        error: "Too many requests",
        message: "Troppe richieste. Riprova più tardi."
      });
    }

    // HONEYPOT CHECK
    const { honeypot } = req.body;
    if (honeypot) {
      console.log(`[SECURITY] Honeypot triggered by IP: ${clientIP}`);
      return res.status(200).json({ status: "ok" });
    }

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Missing RESEND_API_KEY" });
    }

    const {
      appartamento,
      dataArrivo,
      dataPartenza,
      numeroNotti,
      emailOspite,
      guests
    } = req.body;

    if (!emailOspite || !guests || !guests.length) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    /**********************************************
     * GENERAZIONE TXT SECONDO IL FORMATO ALLOGGIATI WEB
     * Formato ufficiale Polizia di Stato
     **********************************************/
    const pad = (val, len) => String(val || "").substring(0, len).padEnd(len, " ");
    const padNum = (val, len) => String(val || "0").padStart(len, "0").substring(0, len);

    // Formato data: gg/mm/aaaa (10 caratteri)
    const formatDate = (d) => {
      if (!d) return "          "; // 10 spazi
      const parts = d.split("-");
      if (parts.length !== 3) return "          ";
      const [year, month, day] = parts;
      return `${day}/${month}/${year}`; // gg/mm/aaaa
    };

    let lines = [];

    for (let i = 0; i < guests.length; i++) {
      const g = guests[i];
      
      // Helper per pulire undefined/null
      const clean = (val) => (val === undefined || val === null || val === "undefined") ? "" : String(val);
      
      // Determina tipo alloggiato: 16 = ospite singolo, 17 = capofamiglia, 18 = capogruppo, 19 = familiare, 20 = membro gruppo
      let tipoAlloggiato = clean(g.tipoAlloggiato);
      if (!tipoAlloggiato) {
        tipoAlloggiato = i === 0 ? "16" : "19";
      }

      // Sesso: deve essere 1 (maschio) o 2 (femmina) - NON convertire in M/F
      let sesso = clean(g.sesso);
      if (!sesso) sesso = " "; // fallback: spazio se vuoto
      
      // Costruisce la riga secondo formato Alloggiati Web (161 caratteri totali)
      // Tipo(2) + DataArrivo(10) + Permanenza(2) + Cognome(50) + Nome(30) + Sesso(1) + DataNascita(10) + ComuneNascita(9) + ProvinciaNascita(2) + StatoNascita(9) + Cittadinanza(9) + TipoDoc(5) + NumeroDoc(20) + LuogoRilascio(9)
      
      const line = [
        pad(tipoAlloggiato, 2),                                              // Tipo Alloggiato (2)
        formatDate(dataArrivo),                                              // Data Arrivo gg/mm/aaaa (10)
        padNum(clean(g.giorni) || numeroNotti || 1, 2),                      // Permanenza giorni (2)
        pad(clean(g.cognome).toUpperCase(), 50),                             // Cognome (50)
        pad(clean(g.nome).toUpperCase(), 30),                                // Nome (30)
        pad(sesso, 1),                                                       // Sesso 1/2 (1)
        formatDate(clean(g.dataNascita)),                                    // Data Nascita gg/mm/aaaa (10)
        pad(clean(g.comuneNascita), 9),                                      // Comune Nascita cod. ISTAT (9)
        pad(clean(g.provinciaNascita).toUpperCase(), 2),                     // Provincia Nascita (2)
        pad(clean(g.statoNascita) || "100000100", 9),                        // Stato Nascita cod. (9)
        pad(clean(g.cittadinanza) || "100000100", 9),                        // Cittadinanza cod. (9)
        pad(clean(g.tipoDocumento).toUpperCase(), 5),                        // Tipo Documento (5)
        pad(clean(g.numeroDocumento).toUpperCase(), 20),                     // Numero Documento (20)
        pad(clean(g.luogoRilascio), 9)                                       // Luogo Rilascio cod. (9)
      ].join("");

      lines.push(line);
    }

    const finalTxt = lines.join("\r\n");

    const encodedTxt = Buffer.from(finalTxt, "utf8").toString("base64");

    /**********************************************
     * GENERA RIEPILOGO LEGGIBILE PER EMAIL
     **********************************************/
    const formatDateReadable = (d) => {
      if (!d) return "-";
      const parts = d.split("-");
      if (parts.length !== 3) return d;
      const [year, month, day] = parts;
      return `${day}/${month}/${year}`;
    };

    const tipoAlloggiatoLabel = (t) => {
      const labels = {
        "16": "Ospite singolo",
        "17": "Capofamiglia",
        "18": "Capogruppo",
        "19": "Familiare",
        "20": "Membro gruppo"
      };
      return labels[t] || t;
    };

    const sessoLabel = (s) => {
      if (s === "1" || s === "M") return "Maschio";
      if (s === "2" || s === "F") return "Femmina";
      return s || "-";
    };

    const tipoDocLabel = (t) => {
      const labels = {
        "IDENT": "Carta d'identità",
        "PATEN": "Patente",
        "PASSP": "Passaporto",
        "PASOR": "Passaporto ordinario",
        "PASDI": "Passaporto diplomatico",
        "PASSE": "Passaporto servizio",
        "ID": "Carta d'identità",
        "PASS": "Passaporto",
        "DL": "Patente"
      };
      return labels[t?.toUpperCase()] || t || "-";
    };

    // Costruisci riepilogo testuale
    let summary = `
════════════════════════════════════════════════════════════════
                    PRE CHECK-IN ALLOGGIATI WEB
════════════════════════════════════════════════════════════════

APPARTAMENTO:     ${appartamento || "-"}
DATA ARRIVO:      ${formatDateReadable(dataArrivo)}
DATA PARTENZA:    ${formatDateReadable(dataPartenza)}
NUMERO NOTTI:     ${numeroNotti || "-"}
EMAIL OSPITE:     ${emailOspite || "-"}

────────────────────────────────────────────────────────────────
                         ELENCO OSPITI
────────────────────────────────────────────────────────────────
`;

    for (let i = 0; i < guests.length; i++) {
      const g = guests[i];
      const clean = (val) => (val === undefined || val === null || val === "undefined") ? "" : String(val);
      
      summary += `
┌─ OSPITE ${i + 1} ─────────────────────────────────────────────
│
│  Tipo:              ${tipoAlloggiatoLabel(clean(g.tipoAlloggiato) || (i === 0 ? "16" : "19"))}
│  Cognome:           ${clean(g.cognome).toUpperCase() || "-"}
│  Nome:              ${clean(g.nome).toUpperCase() || "-"}
│  Sesso:             ${sessoLabel(clean(g.sesso))}
│  Data di nascita:   ${formatDateReadable(clean(g.dataNascita))}
│  Luogo di nascita:  ${clean(g.comuneNascitaNome) || clean(g.statoNascitaNome) || "-"}
│  Cittadinanza:      ${clean(g.cittadinanzaNome) || "-"}
│
│  Documento:         ${tipoDocLabel(clean(g.tipoDocumento))}
│  Numero:            ${clean(g.numeroDocumento).toUpperCase() || "-"}
│  Luogo rilascio:    ${clean(g.luogoRilascioNome) || "-"}
│
└──────────────────────────────────────────────────────────────
`;
    }

    summary += `
════════════════════════════════════════════════════════════════
Il file TXT per Alloggiati Web è allegato a questa email.
════════════════════════════════════════════════════════════════
`;

    /**********************************************
     * INVIO EMAIL CON RESEND
     **********************************************/
    const RESEND_URL = "https://api.resend.com/emails";

    const emailPayload = {
      from: "Pre Check-in <checkin@lovely-venice.it>",
      to: "appturistici.mestre@gmail.com",
      subject: `Alloggiati Web – ${appartamento} – Arrivo ${formatDateReadable(dataArrivo)}`,
      replyTo: emailOspite,
      text: summary,
      attachments: [
        {
          filename: "alloggiati.txt",
          content: encodedTxt
        }
      ]
    };

    const resendRes = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(emailPayload)
    });

    const resendJson = await resendRes.json();

    if (!resendRes.ok) {
      return res.status(500).json({
        error: "Resend API error",
        details: resendJson
      });
    }

    return res.status(200).json({
      status: "ok",
      message: "Email sent successfully",
      resend: resendJson
    });

  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      details: err.message
    });
  }
}
