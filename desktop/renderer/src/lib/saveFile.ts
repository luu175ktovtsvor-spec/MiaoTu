export default async function saveFile(value: Blob | string, name: string) {
  const blob = value instanceof Blob ? value : new Blob([value])
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}
