/** Salon: system prompt + catalog ảnh mẫu — dùng chung Training (browser) và inbox AI (server). */
export const SALON_SYSTEM =
  'Bạn là trợ lý ảo của một salon tóc. Trả lời ngắn gọn, lịch sự, tiếng Việt. ' +
  'Giúp khách đặt lịch, tư vấn dịch vụ và giá theo ngữ cảnh được cung cấp bên dưới.'

export type BranchPage = {
  id: number
  name: string
  address: string
  hotline: string
}

export const BRANCH_PAGES: BranchPage[] = [
  { id: 1, name: 'CN 1 - Quận 1', address: '55 Phạm Viết Chánh, Cầu Ông Lãnh, Quận 1', hotline: '0935311111' },
  { id: 2, name: 'CN 2 - Bình Tân', address: '202-204 Vành Đai Trong, Bình Trị Đông B, Bình Tân', hotline: '0935311111' },
  { id: 3, name: 'CN 3 - Hóc Môn', address: '2/98A Lê Thị Hà, Hóc Môn', hotline: '0935311111' },
  { id: 4, name: 'CN 4 - Quận 12', address: '1078 Nguyễn Ảnh Thủ, Quận 12', hotline: '0935311111' },
  { id: 5, name: 'CN 5 - Gò Vấp', address: '397 Quang Trung, Phường 10, Gò Vấp', hotline: '0935311111' },
  { id: 6, name: 'CN 6 - Thủ Đức', address: '734A Kha Vạn Cân, Linh Đông, Thủ Đức', hotline: '0935311111' },
  { id: 7, name: 'CN 7 - Tân Phú', address: '109 Tân Sơn Nhì, Tân Sơn Nhì, Tân Phú', hotline: '0935311111' },
  { id: 8, name: 'CN 8 - Quận 9', address: '427 Man Thiện, Phường Tăng Nhơn Phú, Quận 9', hotline: '0935311111' },
  { id: 9, name: 'CN 9 - Thủ Dầu Một', address: '238 Đại Lộ Bình Dương, Thủ Dầu Một', hotline: '0935311111' },
  { id: 10, name: 'CN 10 - Bến Cát', address: 'KDC Golden Centercity, Bến Cát', hotline: '0935311111' },
  { id: 11, name: 'CN 11 - Thuận An', address: 'Ô94, DC30, Đường D1, KDC Vietsing, Thuận An', hotline: '0935311111' },
  { id: 12, name: 'CN 12 - Tây Ninh', address: '24 Lãnh Binh Tòng, Trảng Bàng, Tây Ninh', hotline: '0935311111' },
  { id: 13, name: 'CN 13 - Biên Hòa', address: '1118 Nguyễn Ái Quốc, Tân Phong, Biên Hòa', hotline: '0935311111' },
  { id: 14, name: 'CN 14 - Phú Quốc', address: '120 Đường 30/4, TT Dương Đông, Phú Quốc', hotline: '0935311111' },
  { id: 15, name: 'CN 15 - Đà Lạt', address: '33 Phan Bội Châu, Phường 1, TP Đà Lạt', hotline: '0935311111' },
  { id: 16, name: 'CN 16 - Bình Phước', address: '483 Quốc Lộ 14, TX Đồng Xoài, Bình Phước', hotline: '0935311111' },
  { id: 17, name: 'CN 17 - Tây Ninh', address: '953 Cách Mạng Tháng 8, TP Tây Ninh', hotline: '0935311111' },
  { id: 18, name: 'CN 18 - Vũng Tàu', address: '496 Trương Công Định, Phường Vũng Tàu, TP.HCM', hotline: '0935311111' },
  { id: 19, name: 'CN 19 - Nha Trang', address: '150 Nguyễn Thị Minh Khai, Phường Nha Trang, Khánh Hòa', hotline: '0935311111' },
  { id: 20, name: 'CN 20 - An Giang', address: '125 Trần Quang Khải, Phường Rạch Giá, An Giang', hotline: '0935311111' },
]

export function buildFanpagePrompt(branch: BranchPage): string {
  return [
    '--- Fanpage/chi nhánh đang nhắn ---',
    `Khách đang nhắn fanpage ${branch.name}.`,
    `Địa chỉ mặc định của fanpage này: ${branch.address}.`,
    `Hotline/Zalo của fanpage này: ${branch.hotline}. Khi khách cần hotline/Zalo, ưu tiên gửi số này.`,
    'Chỉ gửi địa chỉ chi nhánh mặc định khi khách hỏi địa chỉ/chi nhánh, hỏi salon ở đâu, cần đến salon kiểm tra, hoặc đã rõ dịch vụ + thời gian và cần xác nhận nơi ghé.',
    'Khách chỉ nói "ghé", "chiều ghé", "tối ghé" là tín hiệu đặt lịch, không phải tín hiệu hỏi địa chỉ; khi chưa rõ dịch vụ/kiểu thì chỉ hỏi dịch vụ/kiểu còn thiếu, không tự đưa địa chỉ.',
    'Khi gửi địa chỉ mặc định, phải hỏi khách có tiện qua địa chỉ đó không.',
    'Nếu khách nói xa quá: nêu lý do xứng đáng để khách cân nhắc bỏ thời gian ghé (kỹ thuật xử lý, tư vấn trực tiếp, sản phẩm tốt, bảo hành/ưu đãi phù hợp).',
    'Nếu khách vẫn không tiện: hỏi khu vực/địa chỉ của khách và tư vấn chi nhánh gần nhất theo danh sách chi nhánh trong CONTEXT.md.',
  ].join('\n')
}

export type ImageSampleGroup = {
  key: string
  label: string
  usage: string
  urls: string[]
}

export const IMAGE_SAMPLE_MARKER_RE = /\[\[\s*SEND_IMAGE\s*:\s*([a-z0-9_-]+)\s*\]\]/gi

export const IMAGE_SAMPLE_ALIASES: Record<string, string[]> = {
  moi_noi_long_vu: ['moi noi long vu', 'hinh moi noi', 'mau moi noi'],
  noi_toc: ['noi toc', 'mau noi toc', 'toc noi'],
  noi_long_vu_den_chum_den: ['noi long vu den', 'chum toc den', 'toc noi mau den'],
  toc_ngan_bob_tem: ['toc ngan', 'bob', 'toc tem', 'mau tem'],
  mai_thua: ['mai thua'],
  mai_bay: ['mai bay'],
  mai_phap: ['mai phap'],
  mai_ngang: ['mai ngang'],
  duoi_ngan: ['duoi cup toc ngan', 'duoi thang toc ngan', 'toc ngan ngang vai'],
  duoi_dai: ['duoi cup toc dai', 'duoi thang toc dai'],
  uon_cup: ['uon cup'],
  uon_song_ngan: ['uon song toc ngan', 'uon song ngan'],
  uon_song_dai: ['uon song toc dai', 'uon song dai'],
  uon_hippie: ['uon hippie', 'uon hippi', 'uon hippe', 'xu mi'],
  uon_xoan_tang: ['uon xoan tang', 'xoan tang'],
  uon_xoan_luoi_dai: ['uon xoan luoi dai', 'xoan luoi toc dai', 'uon loi toc dai'],
  uon_xoan_luoi_ngan: ['uon xoan luoi ngan', 'xoan luoi toc ngan', 'uon loi toc ngan'],
  nhuom_phu_bac: ['nhuom phu bac'],
  phu_bac_mau_tram: ['phu bac mau tram', 'nhuom phu bac mau tram'],
  toc_bac: ['toc bac', 'mau cho toc bac'],
  mau_tram: ['mau tram', 'mau toi nhe'],
  mau_thoi_trang: ['mau thoi trang', 'mau noi', 'mau ca tinh'],
  mau_balayage: ['balayage'],
  mau_babylight: ['baby light', 'babylight'],
  nhuom_sang_khong_tay: ['nhuom sang khong can tay', 'mau sang khong tay', 'nhuom khong tay'],
}

export function normalizeSearchText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function slugifyImageSampleLabel(label: string): string {
  const normalized = normalizeSearchText(label)
  return (
    normalized
      .replace(/\b(url|anh|mau|dung|khi|khach|hoi|xem)\b/g, ' ')
      .replace(/\s+/g, '_')
      .replace(/^_+|_+$/g, '') || 'image_sample'
  )
}

export function imageSampleKeyForLabel(label: string): string {
  const normalized = normalizeSearchText(label)
  if (normalized.includes('moi noi long vu')) return 'moi_noi_long_vu'
  if (normalized.includes('noi long vu den') || normalized.includes('chum toc den')) {
    return 'noi_long_vu_den_chum_den'
  }
  if (normalized.includes('noi toc')) return 'noi_toc'
  if (normalized.includes('duoi') && normalized.includes('ngan')) return 'duoi_ngan'
  if (normalized.includes('duoi') && normalized.includes('dai')) return 'duoi_dai'
  if (normalized.includes('uon cup')) return 'uon_cup'
  if (normalized.includes('uon song') && normalized.includes('ngan')) return 'uon_song_ngan'
  if (normalized.includes('uon song') && normalized.includes('dai')) return 'uon_song_dai'
  if (normalized.includes('hippie') || normalized.includes('hippi') || normalized.includes('hippe') || normalized.includes('xu mi')) {
    return 'uon_hippie'
  }
  if (normalized.includes('xoan tang')) return 'uon_xoan_tang'
  if (normalized.includes('xoan luoi') && normalized.includes('dai')) return 'uon_xoan_luoi_dai'
  if (normalized.includes('xoan luoi') && normalized.includes('ngan')) return 'uon_xoan_luoi_ngan'
  if (normalized.includes('toc ngan') || normalized.includes('bob') || normalized.includes('tem')) {
    return 'toc_ngan_bob_tem'
  }
  if (normalized.includes('mai thua')) return 'mai_thua'
  if (normalized.includes('mai bay')) return 'mai_bay'
  if (normalized.includes('mai phap')) return 'mai_phap'
  if (normalized.includes('mai ngang')) return 'mai_ngang'
  if (normalized.includes('phu bac') && normalized.includes('mau tram')) return 'phu_bac_mau_tram'
  if (normalized.includes('nhuom phu bac')) return 'nhuom_phu_bac'
  if (normalized.includes('toc bac')) return 'toc_bac'
  if (normalized.includes('mau tram')) return 'mau_tram'
  if (normalized.includes('mau thoi trang')) return 'mau_thoi_trang'
  if (normalized.includes('balayage')) return 'mau_balayage'
  if (normalized.includes('baby light') || normalized.includes('babylight')) return 'mau_babylight'
  if (normalized.includes('sang khong') || normalized.includes('khong can tay')) return 'nhuom_sang_khong_tay'
  return slugifyImageSampleLabel(label)
}

export function extractImageSampleUrls(text: string): string[] {
  return Array.from(
    new Set(
      text.match(/(?:https?:\/\/[^\s),\]]+|(?:\.?\/)?images\/samples\/[^\s),\]]+)/g) ?? [],
    ),
  )
}

function normalizePublicImageBaseUrl(baseUrl?: string): string {
  const raw = (baseUrl ?? '').trim()
  if (!raw) return ''
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    const u = new URL(withProtocol)
    u.hash = ''
    u.search = ''
    return u.toString().replace(/\/+$/, '')
  } catch {
    return ''
  }
}

export function resolveImageSampleUrl(rawUrl: string, baseUrl?: string): string {
  const trimmed = rawUrl.trim()
  if (!trimmed) return ''
  if (/^https?:\/\//i.test(trimmed)) return trimmed

  const base = normalizePublicImageBaseUrl(baseUrl)
  if (!base) return trimmed

  const cleanPath = trimmed.replace(/^\.?\/*/, '')
  return `${base}/${cleanPath}`
}

export function parseImageSampleGroups(markdown: string): ImageSampleGroup[] {
  const groups: ImageSampleGroup[] = []
  const seenKeys = new Set<string>()
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^- URL\s+(.+?)\s+\((.+?)\):\s*(.+)$/)
    if (!match) continue
    const [, rawLabel, rawUsage, urlText] = match
    const urls = extractImageSampleUrls(urlText)
    if (!urls.length) continue
    const label = rawLabel.trim().replace(/^ảnh mẫu\s+/i, '')
    const usage = rawUsage.trim()
    const baseKey = imageSampleKeyForLabel(label)
    let key = baseKey
    let suffix = 2
    while (seenKeys.has(key)) {
      key = `${baseKey}_${suffix}`
      suffix += 1
    }
    seenKeys.add(key)
    groups.push({ key, label, usage, urls })
  }
  return groups
}

export function buildImageSampleCatalogPrompt(groups: ImageSampleGroup[]): string {
  if (!groups.length) return ''
  return [
    '--- IMAGE SAMPLE ROUTER (không chứa URL) ---',
    'App có database URL ảnh mẫu riêng, URL không nằm trong prompt để tiết kiệm chi phí.',
    'Khi tư vấn dịch vụ/kiểu tóc có nhóm ảnh phù hợp, chủ động thêm marker đúng nhóm ở một dòng riêng: [[SEND_IMAGE:key]].',
    'Không tự viết URL, không giải thích marker cho khách. App sẽ ẩn marker và thay bằng link ảnh thật.',
    'Dùng tối đa 1-2 marker/lượt; chọn nhóm sát nhất với nhu cầu khách.',
    'Khi ngữ cảnh là phủ bạc / tóc bạc / hòa bạc / nuôi bạc, chỉ dùng nhuom_phu_bac, phu_bac_mau_tram hoặc toc_bac; tuyệt đối không dùng mau_tram.',
    'Các key ảnh mẫu:',
    ...groups.map((group) => `- ${group.key}: ${group.label} (${group.usage})`),
  ].join('\n')
}

export function mergeContextWithImageSampleCatalog(
  contextMd: string,
  imageSampleGroups: ImageSampleGroup[],
): string {
  const context = contextMd.trim()
  const imageCatalog = buildImageSampleCatalogPrompt(imageSampleGroups)
  if (!imageCatalog) return context
  return `${context}\n\n${imageCatalog}`.trim()
}

export function compactLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => line.trim() || (index > 0 && index < lines.length - 1))
    .join('\n')
    .trim()
}

export function inferImageSampleKeys(text: string, groups: ImageSampleGroup[]): string[] {
  const normalized = normalizeSearchText(text)
  if (!/\b(anh|hinh|mau|tham khao|xem|gui)\b/.test(normalized)) return []
  const keys: string[] = []
  for (const group of groups) {
    const aliases = IMAGE_SAMPLE_ALIASES[group.key] ?? [
      normalizeSearchText(group.label),
      normalizeSearchText(group.usage),
    ]
    if (aliases.some((alias) => alias && normalized.includes(alias))) {
      keys.push(group.key)
    }
    if (keys.length >= 2) break
  }
  return keys
}

export function isSilverCoverageContext(text: string): boolean {
  const normalized = normalizeSearchText(text)
  return /\b(phu bac|toc bac|bac trang|nhieu bac|hoa bac|nuoi bac)\b/.test(normalized)
}

export function filterImageSampleKeysForContext(keys: string[], contextText: string): string[] {
  if (!isSilverCoverageContext(contextText)) return keys
  return keys.filter((key) => key !== 'mau_tram')
}

export function expandModelImageSampleMarkers(
  rawText: string,
  groups: ImageSampleGroup[],
  triggerText: string,
  /** Inbox: tin khách có boilerplate "ảnh/…" làm bật `inferImageSampleKeys` nhầm — chỉ suy từ câu model. */
  opts?: { inferImageKeysFromModelOnly?: boolean; imageBaseUrl?: string },
): { apiText: string; displayText: string; imageUrls: string[] } {
  const groupsByKey = new Map(groups.map((group) => [group.key, group]))
  const markerKeys: string[] = []
  let hadMarker = false
  const textWithoutMarkers = rawText.replace(IMAGE_SAMPLE_MARKER_RE, (_marker, rawKey: string) => {
    hadMarker = true
    const key = rawKey.trim().toLowerCase()
    if (groupsByKey.has(key) && !markerKeys.includes(key)) markerKeys.push(key)
    return ''
  })
  const inferSource = opts?.inferImageKeysFromModelOnly ? rawText : `${triggerText}\n${rawText}`
  const autoKeys =
    markerKeys.length > 0 ? [] : inferImageSampleKeys(inferSource, groups)
  const keys = filterImageSampleKeysForContext(
    [...markerKeys, ...autoKeys].filter((key, index, arr) => arr.indexOf(key) === index),
    `${triggerText}\n${rawText}`,
  )
  if (!keys.length) {
    const cleanText = hadMarker ? compactLines(textWithoutMarkers) : rawText
    return { apiText: cleanText, displayText: cleanText, imageUrls: [] }
  }

  const baseText = compactLines(textWithoutMarkers)
  const displayAdditions: string[] = []
  const imageUrls: string[] = []
  const seenUrl = new Set<string>()
  for (const key of keys) {
    const group = groupsByKey.get(key)
    if (!group) continue
    const resolvedUrls = group.urls
      .map((u) => resolveImageSampleUrl(u, opts?.imageBaseUrl))
      .filter((u) => u.length > 0)
    displayAdditions.push([`Ảnh mẫu ${group.label}:`, ...resolvedUrls].join('\n'))
    for (const u of resolvedUrls) {
      const t = u.trim()
      if (!t || seenUrl.has(t)) continue
      seenUrl.add(t)
      imageUrls.push(t)
    }
  }

  return {
    apiText: baseText,
    displayText: compactLines([baseText, ...displayAdditions].filter(Boolean).join('\n')),
    imageUrls,
  }
}

export function buildSalonSystemPrompt(contextMd: string, branch: BranchPage): string {
  const trimmed = contextMd.trim()
  const fanpagePrompt = buildFanpagePrompt(branch)
  if (!trimmed) return `${SALON_SYSTEM}\n\n${fanpagePrompt}`
  return `${SALON_SYSTEM}\n\n${fanpagePrompt}\n\n--- Ngữ cảnh salon (CONTEXT.md) ---\n\n${trimmed}`
}

export const PLACEHOLDER_NO_TEXT = '[Tin nhắn không có nội dung text]'
export const PLACEHOLDER_REFERRAL = '[Khách mở hội thoại từ nguồn referral]'

export function isSalonPlaceholderMessageText(text: string): boolean {
  const t = text.trim()
  return t === PLACEHOLDER_NO_TEXT || t === PLACEHOLDER_REFERRAL
}

export function inferBranchForFacebookPage(page: { id: string; name: string }, pageOrderIndex: number): BranchPage {
  const m = page.name.match(/CN\s*(\d{1,2})\b/i)
  if (m) {
    const n = Math.min(BRANCH_PAGES.length, Math.max(1, parseInt(m[1], 10)))
    return BRANCH_PAGES.find((b) => b.id === n) ?? BRANCH_PAGES[0]
  }
  const idx = pageOrderIndex >= 0 ? pageOrderIndex % BRANCH_PAGES.length : 0
  return BRANCH_PAGES[idx] ?? BRANCH_PAGES[0]
}
