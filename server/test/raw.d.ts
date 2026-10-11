// Vite の ?raw import（ファイルの中身を文字列で読む）の型。unit 層のテストが fs を import せずに fixture を読むために使う
declare module "*?raw" {
  const content: string;
  export default content;
}
