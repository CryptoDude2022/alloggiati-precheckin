// Netlify Function: Send Alloggiati TXT via Resend
// Path: /netlify/functions/send-alloggiati-txt.js


export const handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: "Method not allowed" })
      };
    }

    const apiKey = process.env.RESEND_API_KEY;

    if (!apiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing RESEND_API_KEY in Netlify env" })
      };
    }

    const data = JSON.parse(event.body);
    const {
      appartamento,
      dataArrivo,
      dataPartenza,
      numeroNotti,
      emailOspite,
      guests
    } = data;

    if (!emailOspite || !guests || !guests.length) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing required fields" })
      };
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
      from: "Pre Check-in <checkin@lovely-venice.it>", // cambia dopo dominio personalizzato
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
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Resend API error",
          details: resendJson
        })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        status: "ok",
        message: "Email sent successfully",
        resend: resendJson
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Server error",
        details: err.message
      })
    };
  }
};
