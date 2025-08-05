import express from 'express'

const app = express()

const port: number = Number(process.env.PORT_NUMBER)
const mediaPath: string = process.env.MEDIA_DIRECTORY!

app.use(express.static(mediaPath))
app.disable('x-powered-by')

app.listen(port, () => {
  console.log(`Media server started on port ${port}`, 'electron-backend')
})
