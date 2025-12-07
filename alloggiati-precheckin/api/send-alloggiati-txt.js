// Vercel Serverless Function: Send Alloggiati TXT via Resend
// Path: /api/send-alloggiati-txt.js

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const apiKey = process.env.RESEND_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: "Missing RESEND_API_KEY in Vercel env" });
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

      // Converti sesso: 1 = M, 2 = F
      let sesso = clean(g.sesso);
      if (sesso === "1") sesso = "M";
      else if (sesso === "2") sesso = "F";
      else if (!sesso) sesso = " "; // fallback: spazio se vuoto
      
      // Costruisce la riga secondo formato Alloggiati Web (161 caratteri totali)
      // Tipo(2) + DataArrivo(10) + Permanenza(2) + Cognome(50) + Nome(30) + Sesso(1) + DataNascita(10) + ComuneNascita(9) + ProvinciaNascita(2) + StatoNascita(9) + Cittadinanza(9) + TipoDoc(5) + NumeroDoc(20) + LuogoRilascio(9)
      
      const line = [
        pad(tipoAlloggiato, 2),                                              // Tipo Alloggiato (2)
        formatDate(dataArrivo),                                              // Data Arrivo gg/mm/aaaa (10)
        padNum(clean(g.giorni) || numeroNotti || 1, 2),                      // Permanenza giorni (2)
        pad(clean(g.cognome).toUpperCase(), 50),                             // Cognome (50)
        pad(clean(g.nome).toUpperCase(), 30),                                // Nome (30)
        pad(sesso.toUpperCase(), 1),                                         // Sesso M/F (1)
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
     * INVIO EMAIL CON RESEND
     **********************************************/
    const RESEND_URL = "https://api.resend.com/emails";

    const emailPayload = {
      from: "Pre Check-in <checkin@lovely-venice.it>",
      to: "appturistici.mestre@gmail.com",
      subject: `Alloggiati Web TXT file – ${appartamento}`,
      replyTo: emailOspite,
      text: "Attached you will find the TXT file required for the Polizia di Stato (Alloggiati Web).",
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
