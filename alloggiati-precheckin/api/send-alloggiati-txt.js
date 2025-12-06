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
     * GENERAZIONE TXT SECONDO IL FORMATO ALLOGGIATI
     **********************************************/
    const pad = (val, len) => String(val || "").padEnd(len, " ");
    const padLeft = (val, len) => String(val || "").padStart(len, "0");

    const dateFormat = (d) => {
      if (!d) return "000000";
      const [y, m, day] = d.split("-");
      return `${day}${m}${y.slice(2)}`; // ddmmyy
    };

    let lines = [];

    for (let g of guests) {
      const line =
        pad(g.tipoAlloggiato || "", 2) +                      // 2 chars
        pad(dateFormat(dataArrivo), 6) +                       // 6 chars
        padLeft(g.giorni || numeroNotti || "", 2) +           // 2 chars
        pad((g.cognome || "").toUpperCase(), 50) +             // 50 chars
        pad((g.nome || "").toUpperCase(), 30) +                // 30 chars
        pad(g.sesso || "", 1) +                                // 1 char
        pad(dateFormat(g.dataNascita), 6) +                    // 6 chars
        pad(g.statoNascita || "", 9) +                         // 9 chars
        pad(g.cittadinanza || "", 9) +                         // 9 chars
        pad(g.comuneNascita || "", 9) +                        // 9 chars (cod. ISTAT)
        pad(g.provinciaNascita || "", 2) +                     // 2 chars
        pad(g.tipoDocumento || "", 5) +                        // 5 chars
        pad((g.numeroDocumento || "").toUpperCase(), 20) +     // 20 chars
        pad(g.luogoRilascio || "", 9);                         // 9 chars

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
