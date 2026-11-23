import mongoose from 'mongoose';

export const CommandLog = mongoose.model(
  'CommandLog',
  new mongoose.Schema({ cmd: String, source: String, detail: Object }, { timestamps: true })
);

export const RouteLog = mongoose.model(
  'RouteLog',
  new mongoose.Schema(
    { from: Object, to: Object, length: Number, result: String },
    { timestamps: true }
  )
);
