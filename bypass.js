export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method Not Allowed"
    });
  }

  try {
    const { url } = req.body || {};

    if (!url) {
      return res.status(400).json({
        success: false,
        message: "URL tidak boleh kosong"
      });
    }

    const parsedUrl = new URL(url);

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return res.status(400).json({
        success: false,
        message: "Protocol URL tidak didukung"
      });
    }

    return res.status(200).json({
      success: true,
      url: parsedUrl.href,
      message: "URL berhasil diproses"
    });

  } catch (error) {
    return res.status(400).json({
      success: false,
      message: "URL tidak valid"
    });
  }
}
