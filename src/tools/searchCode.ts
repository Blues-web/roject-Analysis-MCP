import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs";
import { z } from "zod";
import { scanFiles } from "../utils/scanner.js";


export function registerSearchTool(server: McpServer){


server.tool(
  "search_code",
  "搜索项目代码",
  
  {
    keyword: z.string()
      .describe("需要搜索的关键词")
  },

  async ({keyword}) => {


    const projectPath =
      "/Users/qujinpeng/hzwq/project";


    const files =
      scanFiles(projectPath);


    const result:string[] = [];


    for(const file of files){

      try{

        const content =
          fs.readFileSync(
            file,
            "utf-8"
          );


        if(content.includes(keyword)){
          result.push(file);
        }


      }catch{

      }

    }


    return {
      content:[
        {
          type:"text",
          text:
            result.length
            ?
            result.join("\n")
            :
            "没有找到匹配文件"
        }
      ]
    };


  }
);


}